#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/runTestAgent.sh pr <base-ref> [options]
  scripts/runTestAgent.sh coverage [frontend|backend|all] [options]

Options:
  --model <id>            Claude model (default claude-sonnet-5-5)
  --maxTurns <n>          turn limit (default 80 for pr, 150 for coverage)
  --maxBudgetUsd <usd>    spend limit in USD (default 5 for pr, 15 for coverage)

Runs the unit-test-agent locally with the same flags, permissions and verification
as the testAgent workflow. Everything is written to .testAgent/; the generated tests
stay in the working tree for you to review and commit.

Requires a clean working tree, Node 22.18+, Claude Code, frontend/node_modules,
backend/.venv, and ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or a logged in claude.
USAGE
}

repoRoot=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repoRoot"

runTests=.claude/skills/run-and-verify-tests/scripts/runTests.ts
mode=${1:-}
[ $# -gt 0 ] && shift

case "$mode" in
  pr)
    baseRef=${1:-}
    if [ -z "$baseRef" ]; then
      usage >&2
      exit 64
    fi
    shift
    maxTurns=80
    maxBudgetUsd=5
    ;;
  coverage)
    scope=all
    if [ $# -gt 0 ] && [[ $1 =~ ^(frontend|backend|all)$ ]]; then
      scope=$1
      shift
    fi
    maxTurns=150
    maxBudgetUsd=15
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac

model=claude-sonnet-5-5
while [ $# -gt 0 ]; do
  case "$1" in
    --model) model=$2 ;;
    --maxTurns) maxTurns=$2 ;;
    --maxBudgetUsd) maxBudgetUsd=$2 ;;
    *)
      usage >&2
      exit 64
      ;;
  esac
  shift 2
done

for requirement in node claude git; do
  if ! command -v "$requirement" > /dev/null; then
    echo "Missing required command: $requirement" >&2
    exit 1
  fi
done
if [ ! -x frontend/node_modules/.bin/vitest ] || [ ! -x backend/.venv/bin/python ]; then
  echo "Install dependencies first (see README.md): frontend/node_modules and backend/.venv" >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=all -- . ':!.testAgent')" ]; then
  echo "The working tree has uncommitted changes. Commit or stash them so the agent's changes can be isolated." >&2
  exit 1
fi

rm -rf .testAgent
mkdir -p .testAgent/logs
headSha=$(git rev-parse HEAD)

if [ "$mode" = pr ]; then
  baseSha=$(git rev-parse --verify "$baseRef^{commit}")
  node .claude/skills/analyze-pr-changes/scripts/changeSet.ts files --base "$baseSha" --head "$headSha" > .testAgent/changeSet.json
  node .github/testAgent/buildPrompt.ts pr --base "$baseSha" --head "$headSha" --maxTurns "$maxTurns" > .testAgent/prompt.md
else
  node .github/testAgent/buildPrompt.ts coverage --scope "$scope" --maxTurns "$maxTurns" > .testAgent/prompt.md
fi

echo "Measuring baseline coverage"
if ! node "$runTests" all --coverage --out .testAgent/baseline > .testAgent/logs/baseline.log 2>&1; then
  echo "The existing suites fail; fix them first. Log: .testAgent/logs/baseline.log" >&2
  exit 1
fi

echo "Running unit-test-agent ($model, at most $maxTurns turns and \$$maxBudgetUsd)"
set +e
claude -p "$(cat .testAgent/prompt.md)" \
  --agent unit-test-agent \
  --permission-mode dontAsk \
  --setting-sources project \
  --settings .claude/testAgent.settings.json \
  --strict-mcp-config \
  --no-session-persistence \
  --model "$model" \
  --max-turns "$maxTurns" \
  --max-budget-usd "$maxBudgetUsd" \
  --output-format json \
  --json-schema "$(cat .claude/skills/test-report/report.schema.json)" \
  > .testAgent/agentOutput.json 2> .testAgent/agentStderr.log
agentExitCode=$?
set -e
echo "Claude Code exited with $agentExitCode"

git add --all -- .
git diff --cached --binary HEAD > .testAgent/agent.patch
git reset --quiet

readList() {
  node -p "require('./.testAgent/verification.json')$1.filter(Boolean).join('\n')"
}

runCheck() {
  local name=$1
  shift
  if "$@" > ".testAgent/logs/$name.log" 2>&1; then
    echo success
  else
    echo failure
  fi
}

pathsOutcome=skipped
typecheckOutcome=skipped
formatOutcome=skipped
suitesOutcome=skipped
stabilityOutcome=skipped

if [ -s .testAgent/agent.patch ]; then
  if node .github/testAgent/verifyPaths.ts --patch .testAgent/agent.patch > .testAgent/verification.json; then
    pathsOutcome=success
  else
    pathsOutcome=failure
  fi
fi

if [ "$pathsOutcome" = success ]; then
  frontendFiles=()
  while IFS= read -r file; do
    if [ -n "$file" ]; then
      frontendFiles+=("$file")
    fi
  done < <(readList ".files.filter((entry) => entry.status !== 'deleted' && entry.path.startsWith('frontend/')).map((entry) => entry.path)")
  frontendTests=()
  while IFS= read -r file; do
    if [ -n "$file" ]; then
      frontendTests+=("$file")
    fi
  done < <(readList '.changedTestFiles.frontend')
  backendTests=()
  while IFS= read -r file; do
    if [ -n "$file" ]; then
      backendTests+=("$file")
    fi
  done < <(readList '.changedTestFiles.backend')

  echo "Verifying the generated tests"
  typecheckOutcome=$(runCheck typecheck node "$runTests" typecheck)
  formatOutcome=success
  if [ "${#frontendFiles[@]}" -gt 0 ]; then
    formatOutcome=$(runCheck format node "$runTests" format --check "${frontendFiles[@]}")
  fi
  suitesOutcome=$(runCheck suites node "$runTests" all --coverage --out .testAgent/after)
  stabilityOutcome=success
  if [ "${#frontendTests[@]}" -gt 0 ]; then
    stabilityOutcome=$(runCheck stability node "$runTests" frontend --repeat 3 "${frontendTests[@]}")
  fi
  if [ "${#backendTests[@]}" -gt 0 ] && [ "$stabilityOutcome" = success ]; then
    stabilityOutcome=$(runCheck stability node "$runTests" backend --repeat 3 "${backendTests[@]}")
  fi
  changeSetArgs=()
  if [ -f .testAgent/changeSet.json ]; then
    changeSetArgs=(--changeSet .testAgent/changeSet.json)
  fi
  if [ -f .testAgent/after/summary.json ]; then
    node .github/testAgent/coverageDelta.ts --before .testAgent/baseline/summary.json \
      --after .testAgent/after/summary.json ${changeSetArgs[@]+"${changeSetArgs[@]}"} > .testAgent/coverageDelta.json
  fi
fi

node .github/testAgent/renderReport.ts \
  --agentOutput .testAgent/agentOutput.json \
  --verification .testAgent/verification.json \
  --coverageDelta .testAgent/coverageDelta.json \
  --check "paths=$pathsOutcome" \
  --check "typecheck=$typecheckOutcome" \
  --check "format=$formatOutcome" \
  --check "suites=$suitesOutcome" \
  --check "stability=$stabilityOutcome" \
  --push skipped \
  --headSha "$headSha" \
  --model "$model" \
  --logs .testAgent/logs > .testAgent/report.md

echo "Report: .testAgent/report.md"
echo "paths=$pathsOutcome typecheck=$typecheckOutcome format=$formatOutcome suites=$suitesOutcome stability=$stabilityOutcome"
if [ "$pathsOutcome" = failure ] || [ "$typecheckOutcome" = failure ] || [ "$formatOutcome" = failure ] \
  || [ "$suitesOutcome" = failure ] || [ "$stabilityOutcome" = failure ]; then
  exit 1
fi
