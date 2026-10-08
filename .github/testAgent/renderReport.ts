import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { CoverageDelta, Delta } from './coverageDelta.ts'
import type { Verification } from './verifyPaths.ts'

export const commentMarker = '<!-- test-agent-report -->'

export type Outcome =
  | 'skippedNoCredentials'
  | 'baselineFailed'
  | 'agentFailed'
  | 'noChanges'
  | 'verificationFailed'
  | 'pushFailed'
  | 'pushed'
  | 'verifiedNotPushed'

export interface FileDecision {
  path: string
  area: string
  decision: 'created' | 'updated' | 'skipped'
  reason: string
  testFiles: string[]
  testsAdded: number
  testsUpdated: number
}

export interface Finding {
  path: string
  line: number | null
  severity: 'bug' | 'risk' | 'question'
  title: string
  detail: string
  evidence: string
}

export interface AgentReport {
  mode: 'pr' | 'coverage'
  summary: string
  testsPassing: boolean
  files: FileDecision[]
  findings: Finding[]
  commands: { command: string; exitCode: number; summary: string }[]
}

export interface AgentOutput {
  subtype?: string
  is_error?: boolean
  result?: string
  structured_output?: AgentReport
  total_cost_usd?: number
  num_turns?: number
  duration_ms?: number
  session_id?: string
}

export interface ReportContext {
  credentials: 'present' | 'missing'
  baseline: string
  agentOutput: AgentOutput | null
  verification: Verification | null
  coverageDelta: CoverageDelta | null
  checks: Record<string, string>
  push: string
  commit: string | null
  headSha: string | null
  runUrl: string | null
  model: string | null
  failureLogs: Record<string, string>
}

const checkLabels: Record<string, string> = {
  paths: 'Changed paths stay inside the test allowlist',
  typecheck: 'Frontend typecheck',
  format: 'Prettier on changed frontend tests',
  suites: 'Full frontend and backend suites with coverage',
  stability: 'Changed tests rerun (shuffled, shifted time zone)',
}
const requiredChecks = ['paths', 'suites']
const maxCommentLength = 60000

export function agentReportOf(output: AgentOutput | null): AgentReport | null {
  if (!output || output.is_error || !output.structured_output) return null
  const report = output.structured_output
  return Array.isArray(report.files) && Array.isArray(report.findings)
    ? report
    : null
}

export function decideOutcome(context: ReportContext): Outcome {
  if (context.credentials === 'missing') return 'skippedNoCredentials'
  if (context.baseline === 'failure') return 'baselineFailed'
  if (agentReportOf(context.agentOutput) === null) return 'agentFailed'
  if (!context.verification || context.verification.files.length === 0)
    return 'noChanges'
  const checksFailed =
    Object.values(context.checks).some(
      (outcome) => outcome === 'failure' || outcome === 'cancelled',
    ) || requiredChecks.some((name) => context.checks[name] !== 'success')
  if (!context.verification.ok || checksFailed) return 'verificationFailed'
  if (context.push === 'success') return 'pushed'
  if (context.push === 'failure') return 'pushFailed'
  return 'verifiedNotPushed'
}

export function inlineText(value: unknown, maxLength = 300): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const clipped =
    text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text
  return clipped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/@(?=\w)/g, '@&#8203;')
}

export function codeSpan(value: string): string {
  return /^[\w./@+:-]+$/.test(value) ? `\`${value}\`` : inlineText(value, 200)
}

export function fencedBlock(content: string, language = ''): string {
  const longestRun = Math.max(
    2,
    ...[...content.matchAll(/`+/g)].map((match) => match[0].length),
  )
  const fence = '`'.repeat(longestRun + 1)
  return `${fence}${language}\n${content.replace(/\n+$/, '')}\n${fence}`
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${value}%`
}

export function formatDelta(value: Delta): string {
  if (value.before === null || value.after === null) {
    return `${percent(value.before)} -> ${percent(value.after)}`
  }
  const change = value.change ?? 0
  const sign = change > 0 ? '+' : ''
  return `${percent(value.before)} -> ${percent(value.after)} (${sign}${change})`
}

function headline(outcome: Outcome, context: ReportContext): string {
  const shortCommit = context.commit ? context.commit.slice(0, 7) : ''
  switch (outcome) {
    case 'skippedNoCredentials':
      return 'Skipped: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is configured as a repository secret, so the agent did not run. Add one under Settings > Secrets and variables > Actions and push again.'
    case 'baselineFailed':
      return 'Skipped: the existing frontend or backend suite already fails on this PR head, so the agent did not run. Fix the failing tests first; the logs are in the workflow run.'
    case 'agentFailed':
      return `The agent did not finish with a valid report (${inlineText(context.agentOutput?.subtype ?? 'no output', 80)}). Nothing was pushed.`
    case 'noChanges':
      return 'The agent decided that no test changes are needed. Nothing was pushed.'
    case 'verificationFailed':
      return 'Independent verification failed, so the generated tests were NOT pushed. See the failing checks below.'
    case 'pushFailed':
      return 'Verification passed, but pushing the tests failed (most likely the branch moved). The patch is attached to the workflow run.'
    case 'pushed':
      return `Tests verified and pushed in ${codeSpan(shortCommit)}.`
    case 'verifiedNotPushed':
      return 'Tests verified. They were not pushed; review and commit them yourself.'
  }
}

function decisionsSection(report: AgentReport): string[] {
  if (report.files.length === 0) return ['No source files were in scope.']
  const rows = report.files.map((file) => {
    const tests = file.testFiles.length
      ? `+${file.testsAdded} / ~${file.testsUpdated} in ${file.testFiles.map(codeSpan).join(', ')}`
      : '-'
    return `| ${codeSpan(file.path)} | ${file.decision} | ${tests} | ${inlineText(file.reason)} |`
  })
  return [
    '| Source file | Decision | Tests (added / updated) | Reason |',
    '|---|---|---|---|',
    ...rows,
  ]
}

function findingsSection(report: AgentReport): string[] {
  if (report.findings.length === 0) return ['No suspected product bugs.']
  return report.findings.map((finding) => {
    const location =
      finding.line === null ? finding.path : `${finding.path}:${finding.line}`
    return `- **${finding.severity}** ${codeSpan(location)}: ${inlineText(finding.title, 200)}. ${inlineText(finding.detail, 600)} Evidence: ${inlineText(finding.evidence, 300)}`
  })
}

function verificationSection(context: ReportContext): string[] {
  const lines = ['| Check | Result |', '|---|---|']
  for (const [name, label] of Object.entries(checkLabels)) {
    const outcome = context.checks[name] ?? 'skipped'
    const result =
      outcome === 'success'
        ? 'pass'
        : outcome === 'failure'
          ? '**fail**'
          : outcome
    lines.push(`| ${label} | ${result} |`)
  }
  const notes = [
    ...(context.verification?.violations ?? []).map((entry) => ({
      kind: 'violation',
      ...entry,
    })),
    ...(context.verification?.warnings ?? []).map((entry) => ({
      kind: 'warning',
      ...entry,
    })),
  ]
  if (notes.length > 0) lines.push('')
  for (const note of notes) {
    lines.push(
      `- ${note.kind} ${codeSpan(note.rule)} in ${codeSpan(note.path)}: ${inlineText(note.detail)}`,
    )
  }
  for (const [name, log] of Object.entries(context.failureLogs)) {
    lines.push(
      '',
      `<details><summary>Last lines of the ${inlineText(checkLabels[name] ?? name, 80)} log</summary>`,
      '',
      fencedBlock(log),
      '',
      '</details>',
    )
  }
  return lines
}

function coverageSection(coverage: CoverageDelta): string[] {
  const lines = ['| Stack | Lines | Branches |', '|---|---|---|']
  for (const stack of coverage.stacks) {
    lines.push(
      `| ${stack.stack} | ${formatDelta(stack.lines)} | ${formatDelta(stack.branches)} |`,
    )
  }
  if (coverage.files.length > 0) {
    lines.push('', '| File | Line coverage |', '|---|---|')
    for (const file of coverage.files.slice(0, 40)) {
      lines.push(`| ${codeSpan(file.path)} | ${formatDelta(file.lines)} |`)
    }
  }
  return lines
}

function runSection(
  context: ReportContext,
  report: AgentReport | null,
): string[] {
  const output = context.agentOutput
  if (!output) return []
  const facts = [
    context.model ? `model ${codeSpan(context.model)}` : null,
    output.num_turns !== undefined ? `${output.num_turns} turns` : null,
    output.total_cost_usd !== undefined
      ? `cost $${output.total_cost_usd.toFixed(2)}`
      : null,
    output.duration_ms !== undefined
      ? `${Math.round(output.duration_ms / 1000)} s`
      : null,
    output.subtype ? `result ${codeSpan(output.subtype)}` : null,
  ].filter(Boolean)
  const lines = ['<details><summary>Agent run</summary>', '', facts.join(', ')]
  if (report && report.commands.length > 0) {
    const commands = report.commands
      .map(
        (entry) =>
          `[exit ${entry.exitCode}] ${entry.command}\n    ${entry.summary.replace(/\s+/g, ' ')}`,
      )
      .join('\n')
    lines.push('', fencedBlock(commands, 'text'))
  }
  lines.push('', '</details>')
  return lines
}

export function renderReport(context: ReportContext): string {
  const outcome = decideOutcome(context)
  const report = agentReportOf(context.agentOutput)
  const sections: string[][] = [
    [
      commentMarker,
      '## Unit test agent',
      '',
      `**${headline(outcome, context)}**`,
    ],
  ]
  if (report) {
    sections.push([inlineText(report.summary, 1500)])
    sections.push(['### Decisions', '', ...decisionsSection(report)])
    sections.push(['### Findings', '', ...findingsSection(report)])
  }
  if (context.verification || Object.keys(context.checks).length > 0) {
    sections.push(['### Verification', '', ...verificationSection(context)])
  }
  if (context.coverageDelta) {
    sections.push([
      '### Coverage',
      '',
      ...coverageSection(context.coverageDelta),
    ])
  }
  sections.push(runSection(context, report))
  const footer = [
    context.runUrl
      ? `[Workflow run](${context.runUrl}) has the agent output, patch and coverage reports as artifacts.`
      : null,
    context.headSha
      ? `Analyzed head ${codeSpan(context.headSha.slice(0, 7))}.`
      : null,
    'Add the `skip-test-agent` label to stop the agent on this pull request.',
  ].filter(Boolean)
  sections.push([footer.join(' ')])
  const markdown = sections
    .filter((section) => section.length > 0)
    .map((section) => section.join('\n'))
    .join('\n\n')
  if (markdown.length <= maxCommentLength) return `${markdown}\n`
  const cut = markdown.lastIndexOf('\n', maxCommentLength)
  return `${markdown.slice(0, cut)}\n\n_Report truncated; the full version is in the workflow step summary._\n`
}

function readOptionalJson<T>(filePath: string | undefined): T | null {
  if (!filePath || !existsSync(filePath)) return null
  const content = readFileSync(filePath, 'utf8').trim()
  if (content === '') return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

export function tail(content: string, lineCount: number): string {
  return content.split('\n').slice(-lineCount).join('\n')
}

function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      agentOutput: { type: 'string' },
      verification: { type: 'string' },
      coverageDelta: { type: 'string' },
      credentials: { type: 'string', default: 'present' },
      baseline: { type: 'string', default: 'success' },
      check: { type: 'string', multiple: true, default: [] },
      push: { type: 'string', default: 'skipped' },
      commit: { type: 'string' },
      headSha: { type: 'string' },
      runUrl: { type: 'string' },
      model: { type: 'string' },
      logs: { type: 'string' },
    },
  })
  const checks = Object.fromEntries(
    values.check
      .map((entry) => entry.split('='))
      .filter(([name, outcome]) => name && outcome)
      .map(([name, outcome]) => [name, outcome]),
  )
  const failureLogs: Record<string, string> = {}
  for (const [name, outcome] of Object.entries(checks)) {
    const logPath = values.logs ? path.join(values.logs, `${name}.log`) : null
    if (outcome === 'failure' && logPath && existsSync(logPath)) {
      failureLogs[name] = tail(readFileSync(logPath, 'utf8'), 60)
    }
  }
  process.stdout.write(
    renderReport({
      credentials: values.credentials === 'missing' ? 'missing' : 'present',
      baseline: values.baseline,
      agentOutput: readOptionalJson<AgentOutput>(values.agentOutput),
      verification: readOptionalJson<Verification>(values.verification),
      coverageDelta: readOptionalJson<CoverageDelta>(values.coverageDelta),
      checks,
      push: values.push,
      commit: values.commit || null,
      headSha: values.headSha || null,
      runUrl: values.runUrl || null,
      model: values.model || null,
      failureLogs,
    }),
  )
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
