import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { ChangeSet } from '../../.claude/skills/analyze-pr-changes/scripts/changeSet.ts'
import type {
  CoverageSummary,
  FileCoverage,
  StackCoverage,
} from '../../.claude/skills/run-and-verify-tests/scripts/coverageSummary.ts'

export interface Delta {
  before: number | null
  after: number | null
  change: number | null
}

export interface StackDelta {
  stack: 'frontend' | 'backend'
  lines: Delta
  branches: Delta
}

export interface FileDelta {
  path: string
  lines: Delta
}

export interface CoverageDelta {
  stacks: StackDelta[]
  files: FileDelta[]
}

export function delta(before: number | null, after: number | null): Delta {
  const change =
    before === null || after === null
      ? null
      : Math.round((after - before) * 100) / 100
  return { before, after, change }
}

function filesByPath(summary: CoverageSummary): Map<string, FileCoverage> {
  return new Map(
    [...(summary.frontend?.files ?? []), ...(summary.backend?.files ?? [])].map(
      (file) => [file.path, file],
    ),
  )
}

export function computeDelta(
  before: CoverageSummary,
  after: CoverageSummary,
  focusPaths: string[] | null,
): CoverageDelta {
  const stacks = (['frontend', 'backend'] as const)
    .filter((stack) => before[stack] !== null || after[stack] !== null)
    .map((stack): StackDelta => {
      const pick = (
        summary: StackCoverage | null,
        metric: 'lines' | 'branches',
      ) => (summary ? summary.total[metric].pct : null)
      return {
        stack,
        lines: delta(pick(before[stack], 'lines'), pick(after[stack], 'lines')),
        branches: delta(
          pick(before[stack], 'branches'),
          pick(after[stack], 'branches'),
        ),
      }
    })
  const beforeFiles = filesByPath(before)
  const afterFiles = filesByPath(after)
  const candidatePaths = focusPaths ?? [
    ...new Set([...beforeFiles.keys(), ...afterFiles.keys()]),
  ]
  const files = candidatePaths
    .map((path) => ({
      path,
      lines: delta(
        beforeFiles.get(path)?.lines.pct ?? null,
        afterFiles.get(path)?.lines.pct ?? null,
      ),
    }))
    .filter((file) => focusPaths !== null || (file.lines.change ?? 0) !== 0)
    .sort(
      (left, right) =>
        (right.lines.change ?? 0) - (left.lines.change ?? 0) ||
        left.path.localeCompare(right.path),
    )
  return { stacks, files }
}

export function sourcePathsOf(changeSet: ChangeSet): string[] {
  return changeSet.files
    .filter(
      (file) =>
        (file.area === 'frontendSource' || file.area === 'backendSource') &&
        file.status !== 'deleted',
    )
    .map((file) => file.path)
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
      changeSet: { type: 'string' },
    },
  })
  if (!values.before || !values.after) {
    process.stderr.write(
      'Usage: coverageDelta.ts --before <summary.json> --after <summary.json> [--changeSet <changeSet.json>]\n',
    )
    process.exit(64)
  }
  const focusPaths = values.changeSet
    ? sourcePathsOf(readJson<ChangeSet>(values.changeSet))
    : null
  const result = computeDelta(
    readJson<CoverageSummary>(values.before),
    readJson<CoverageSummary>(values.after),
    focusPaths,
  )
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
