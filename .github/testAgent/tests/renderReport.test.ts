import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { CoverageDelta } from '../coverageDelta.ts'
import {
  agentReportOf,
  codeSpan,
  commentMarker,
  decideOutcome,
  fencedBlock,
  formatDelta,
  inlineText,
  renderReport,
  type AgentOutput,
  type ReportContext,
} from '../renderReport.ts'
import { parsePatch, verifyPatch } from '../verifyPaths.ts'
import {
  createTempDirectory,
  fixturesDirectory,
  writeFiles,
} from './helpers.ts'

const agentOutput: AgentOutput = JSON.parse(
  readFileSync(path.join(fixturesDirectory, 'agentOutput.json'), 'utf8'),
)
const patch = readFileSync(
  path.join(fixturesDirectory, 'agentPatch.diff'),
  'utf8',
)
const verification = verifyPatch(parsePatch(patch), patch.length, 524288)
const passingChecks = {
  paths: 'success',
  typecheck: 'success',
  format: 'success',
  suites: 'success',
  stability: 'success',
}
const coverageDelta: CoverageDelta = {
  stacks: [
    {
      stack: 'frontend',
      lines: { before: 47.68, after: 52.31, change: 4.63 },
      branches: { before: 43.79, after: 46.71, change: 2.92 },
    },
  ],
  files: [
    {
      path: 'frontend/src/lib/http.ts',
      lines: { before: 0, after: 100, change: 100 },
    },
  ],
}

function context(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    credentials: 'present',
    baseline: 'success',
    agentOutput,
    verification,
    coverageDelta,
    checks: passingChecks,
    push: 'success',
    commit: 'abcdef1234567890',
    headSha: '1234567890abcdef',
    runUrl: 'https://github.com/acme/taskly/actions/runs/1',
    model: 'claude-sonnet-5-5',
    failureLogs: {},
    ...overrides,
  }
}

describe('decideOutcome', () => {
  const cases: [string, Partial<ReportContext>, string][] = [
    [
      'missing credentials',
      { credentials: 'missing', agentOutput: null },
      'skippedNoCredentials',
    ],
    [
      'failing baseline',
      { baseline: 'failure', agentOutput: null },
      'baselineFailed',
    ],
    ['no agent output', { agentOutput: null }, 'agentFailed'],
    [
      'agent error',
      {
        agentOutput: {
          ...agentOutput,
          is_error: true,
          subtype: 'error_max_turns',
        },
      },
      'agentFailed',
    ],
    [
      'report without structured output',
      { agentOutput: { subtype: 'success', is_error: false } },
      'agentFailed',
    ],
    ['empty patch', { verification: verifyPatch([], 0, 1) }, 'noChanges'],
    ['no verification at all', { verification: null }, 'noChanges'],
    [
      'failed check',
      { checks: { ...passingChecks, stability: 'failure' } },
      'verificationFailed',
    ],
    [
      'required check skipped',
      { checks: { ...passingChecks, suites: 'skipped' } },
      'verificationFailed',
    ],
    [
      'path violation',
      { verification: { ...verification, ok: false } },
      'verificationFailed',
    ],
    [
      'optional check skipped',
      { checks: { ...passingChecks, typecheck: 'skipped', format: 'skipped' } },
      'pushed',
    ],
    ['push rejected', { push: 'failure' }, 'pushFailed'],
    ['local run', { push: 'skipped' }, 'verifiedNotPushed'],
  ]
  for (const [name, overrides, outcome] of cases) {
    it(`returns ${outcome} for ${name}`, () => {
      assert.equal(decideOutcome(context(overrides)), outcome)
    })
  }
})

describe('escaping', () => {
  it('neutralizes table breaks, HTML and mentions in model-written text', () => {
    assert.equal(
      inlineText('a | b <script> @octocat\nnext & more'),
      'a \\| b &lt;script&gt; @&#8203;octocat next &amp; more',
    )
    assert.equal(inlineText('x'.repeat(20), 10), 'xxxxxxx...')
  })

  it('uses code spans only for plain paths', () => {
    assert.equal(
      codeSpan('frontend/src/lib/http.ts'),
      '`frontend/src/lib/http.ts`',
    )
    assert.equal(codeSpan('a`b'), 'a`b')
  })

  it('picks a fence longer than any backtick run in the content', () => {
    assert.equal(
      fencedBlock('run ```x```', 'text'),
      '````text\nrun ```x```\n````',
    )
    assert.equal(fencedBlock('plain\n\n'), '```\nplain\n```')
  })

  it('formats coverage changes with a sign', () => {
    assert.equal(
      formatDelta({ before: 47.68, after: 52.31, change: 4.63 }),
      '47.68% -> 52.31% (+4.63)',
    )
    assert.equal(
      formatDelta({ before: 50, after: 40, change: -10 }),
      '50% -> 40% (-10)',
    )
    assert.equal(
      formatDelta({ before: null, after: 40, change: null }),
      'n/a -> 40%',
    )
  })
})

describe('renderReport', () => {
  it('renders a complete comment for a pushed run', () => {
    const markdown = renderReport(context())
    assert.ok(markdown.startsWith(`${commentMarker}\n## Unit test agent`))
    assert.match(markdown, /\*\*Tests verified and pushed in `abcdef1`\.\*\*/)
    assert.match(
      markdown,
      /\| `frontend\/src\/lib\/http\.ts` \| created \| \+4 \/ ~0 in `frontend\/src\/lib\/http\.test\.ts` \|/,
    )
    assert.match(
      markdown,
      /\| `frontend\/src\/features\/todos\/types\.ts` \| skipped \| - \| typesOnly: adds a union member\. \|/,
    )
    assert.match(
      markdown,
      /- \*\*bug\*\* `frontend\/src\/lib\/http\.ts:14`: 422 hides the server detail\./,
    )
    assert.match(
      markdown,
      /### Skills used\n\n- `frontend-unit-tests`: Mocked lib\/http and covered the 422 and network error paths\.\n- `run-and-verify-tests`: /,
    )
    assert.match(
      markdown,
      /\| Full frontend and backend suites with coverage \| pass \|/,
    )
    assert.match(
      markdown,
      /\| frontend \| 47\.68% -> 52\.31% \(\+4\.63\) \| 43\.79% -> 46\.71% \(\+2\.92\) \|/,
    )
    assert.match(
      markdown,
      /model `claude-sonnet-5-5`, 23 turns, cost \$0\.83, 184 s, result `success`/,
    )
    assert.match(markdown, /@&#8203;octocat/)
    assert.doesNotMatch(markdown, /<b>/)
    assert.match(
      markdown,
      /\[Workflow run\]\(https:\/\/github\.com\/acme\/taskly\/actions\/runs\/1\)/,
    )
  })

  it('explains a verification failure with violations and the failing log tail', () => {
    const failing = verifyPatch(
      parsePatch(
        'diff --git a/backend/app/main.py b/backend/app/main.py\n--- a/backend/app/main.py\n+++ b/backend/app/main.py\n@@ -1 +1 @@\n-a\n+b\n',
      ),
      80,
      524288,
    )
    const markdown = renderReport(
      context({
        verification: failing,
        checks: { ...passingChecks, paths: 'failure', suites: 'skipped' },
        push: 'skipped',
        failureLogs: { paths: 'outsideAllowlist backend/app/main.py' },
      }),
    )
    assert.match(markdown, /were NOT pushed/)
    assert.match(
      markdown,
      /\| Changed paths stay inside the test allowlist \| \*\*fail\*\* \|/,
    )
    assert.match(
      markdown,
      /- violation `outsideAllowlist` in `backend\/app\/main\.py`/,
    )
    assert.match(
      markdown,
      /<details><summary>Last lines of the Changed paths stay inside the test allowlist log<\/summary>\n\n```\noutsideAllowlist backend\/app\/main\.py\n```/,
    )
  })

  it('says so when an older report lists no skills', () => {
    const { skillsUsed, ...withoutSkills } = agentOutput.structured_output!
    assert.ok(skillsUsed)
    const markdown = renderReport(
      context({
        agentOutput: { ...agentOutput, structured_output: withoutSkills },
      }),
    )
    assert.match(
      markdown,
      /### Skills used\n\nThe agent did not list any skills\./,
    )
  })

  it('renders only the skip notice when credentials are missing', () => {
    const markdown = renderReport(
      context({
        credentials: 'missing',
        agentOutput: null,
        verification: null,
        coverageDelta: null,
        checks: {},
        push: 'skipped',
        commit: null,
      }),
    )
    assert.match(
      markdown,
      /neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN/,
    )
    assert.doesNotMatch(
      markdown,
      /### Decisions|### Verification|### Coverage|Agent run/,
    )
  })

  it('truncates oversized comments at a line boundary', () => {
    const files = Array.from({ length: 400 }, (_, index) => ({
      path: `frontend/src/generated/Module${index}.tsx`,
      area: 'frontend',
      decision: 'skipped' as const,
      reason: 'x'.repeat(300),
      testFiles: [],
      testsAdded: 0,
      testsUpdated: 0,
    }))
    const report = agentReportOf(agentOutput)
    assert.ok(report)
    const markdown = renderReport(
      context({
        agentOutput: {
          ...agentOutput,
          structured_output: { ...report, files },
        },
      }),
    )
    assert.ok(markdown.length < 61000)
    assert.match(
      markdown,
      /_Report truncated; the full version is in the workflow step summary\._\n$/,
    )
  })
})

describe('renderReport command line', () => {
  it('reads files, checks and logs from arguments', () => {
    const directory = createTempDirectory()
    writeFiles(directory, {
      'logs/suites.log': 'line 1\nFAILED tests/test_x.py::test_y\n',
      'verification.json': JSON.stringify(verification),
    })
    const outcome = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, '../renderReport.ts'),
        '--agentOutput',
        path.join(fixturesDirectory, 'agentOutput.json'),
        '--verification',
        path.join(directory, 'verification.json'),
        '--coverageDelta',
        path.join(directory, 'missing.json'),
        '--check',
        'paths=success',
        '--check',
        'suites=failure',
        '--logs',
        path.join(directory, 'logs'),
        '--push',
        'skipped',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(outcome.status, 0, outcome.stderr)
    assert.match(outcome.stdout, /were NOT pushed/)
    assert.match(outcome.stdout, /FAILED tests\/test_x\.py::test_y/)
    assert.doesNotMatch(outcome.stdout, /### Coverage/)
  })
})
