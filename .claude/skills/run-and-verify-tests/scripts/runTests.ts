import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  isCommittablePath,
  isScratchPath,
  resolveRepoPath,
} from '../../../hooks/pathPolicy.ts'
import { readCoverageSummary } from './coverageSummary.ts'

export interface Invocation {
  label: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface SuiteOptions {
  files: string[]
  coverageDirectory: string | null
  match: string | null
  variant: number
}

const inheritedVariables = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TZ',
  'CI',
  'TERM',
]
const alternateTimeZones = ['Pacific/Kiritimati', 'Pacific/Pago_Pago']
const frontendTestFile = /^frontend\/src\/(?:[^/]+\/)*[^/]+\.test\.tsx?$/
const backendTestFile = /^backend\/tests\/(?:[^/]+\/)*[^/]+\.py$/

export function scrubEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of inheritedVariables) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  return { ...environment, NO_COLOR: '1', ...overrides }
}

export function variantLabel(variant: number): string {
  if (variant === 0) return 'default order and time zone'
  return `TZ=${variantTimeZone(variant)}, shuffled with seed ${variant}`
}

function variantTimeZone(variant: number): string {
  return alternateTimeZones[(variant - 1) % alternateTimeZones.length]
}

function variantEnvironment(variant: number): Record<string, string> {
  return variant === 0 ? {} : { TZ: variantTimeZone(variant) }
}

function assertNotOption(value: string, name: string) {
  if (value.startsWith('-')) {
    throw new Error(`${name} must not start with "-": ${value}`)
  }
}

export function resolveTestFiles(
  repoRoot: string,
  files: string[],
  stack: 'frontend' | 'backend',
): string[] {
  const pattern = stack === 'frontend' ? frontendTestFile : backendTestFile
  return files.map((file) => {
    assertNotOption(file, 'Test file')
    const [filePath, ...nodeId] = file.split('::')
    if (stack === 'frontend' && nodeId.length > 0) {
      throw new Error(`Vitest does not accept node ids, use --match: ${file}`)
    }
    const relativePath = resolveRepoPath(repoRoot, filePath, process.cwd())
    if (
      relativePath === null ||
      !pattern.test(relativePath) ||
      !existsSync(path.join(repoRoot, relativePath))
    ) {
      throw new Error(`Not an existing ${stack} test file: ${file}`)
    }
    return [relativePath, ...nodeId].join('::')
  })
}

export function resolveOutputDirectory(
  repoRoot: string,
  directory: string,
): string {
  const relativePath = resolveRepoPath(repoRoot, directory, process.cwd())
  if (relativePath === null || !isScratchPath(relativePath)) {
    throw new Error(
      `Coverage output must be a subdirectory of .testAgent/: ${directory}`,
    )
  }
  return path.join(repoRoot, relativePath)
}

export function frontendInvocation(
  repoRoot: string,
  options: SuiteOptions,
): Invocation {
  const args = ['run']
  if (options.variant > 0) {
    args.push('--sequence.shuffle', `--sequence.seed=${options.variant}`)
  }
  if (options.match) args.push('--testNamePattern', options.match)
  if (options.coverageDirectory) {
    args.push(
      '--coverage.enabled=true',
      '--coverage.reporter=json',
      '--coverage.reporter=json-summary',
      '--coverage.reporter=text-summary',
      `--coverage.reportsDirectory=${path.join(options.coverageDirectory, 'frontend')}`,
    )
  }
  args.push(
    ...options.files.map((file) => path.posix.relative('frontend', file)),
  )
  return {
    label: `frontend tests (${variantLabel(options.variant)})`,
    command: path.join(repoRoot, 'frontend/node_modules/.bin/vitest'),
    args,
    cwd: path.join(repoRoot, 'frontend'),
    env: scrubEnvironment(process.env, variantEnvironment(options.variant)),
  }
}

export function backendInvocation(
  repoRoot: string,
  options: SuiteOptions,
): Invocation {
  const args = ['-m', 'pytest', '-p', 'no:cacheprovider', '-q']
  const overrides = variantEnvironment(options.variant)
  if (options.match) args.push('-k', options.match)
  if (options.coverageDirectory) {
    const directory = path.join(options.coverageDirectory, 'backend')
    overrides.COVERAGE_FILE = path.join(directory, '.coverage')
    args.push(
      '--cov=app',
      '--cov-branch',
      `--cov-report=json:${path.join(directory, 'coverage.json')}`,
      '--cov-report=term-missing:skip-covered',
    )
  }
  args.push(
    ...options.files.map((file) => path.posix.relative('backend', file)),
  )
  return {
    label: `backend tests (${variantLabel(options.variant)})`,
    command: path.join(repoRoot, 'backend/.venv/bin/python'),
    args,
    cwd: path.join(repoRoot, 'backend'),
    env: scrubEnvironment(process.env, overrides),
  }
}

export function typecheckInvocation(repoRoot: string): Invocation {
  return {
    label: 'frontend typecheck',
    command: path.join(repoRoot, 'frontend/node_modules/.bin/tsc'),
    args: ['--noEmit', '-p', 'tsconfig.json'],
    cwd: path.join(repoRoot, 'frontend'),
    env: scrubEnvironment(process.env),
  }
}

export function formatInvocation(
  repoRoot: string,
  files: string[],
  check: boolean,
): Invocation {
  const relativePaths = files.map((file) => {
    assertNotOption(file, 'File')
    const relativePath = resolveRepoPath(repoRoot, file, process.cwd())
    if (
      relativePath === null ||
      !relativePath.startsWith('frontend/') ||
      !isCommittablePath(relativePath) ||
      !existsSync(path.join(repoRoot, relativePath))
    ) {
      throw new Error(
        `Only existing frontend test files can be formatted: ${file}`,
      )
    }
    return path.posix.relative('frontend', relativePath)
  })
  return {
    label: check ? 'prettier check' : 'prettier write',
    command: path.join(repoRoot, 'frontend/node_modules/.bin/prettier'),
    args: [check ? '--check' : '--write', ...relativePaths],
    cwd: path.join(repoRoot, 'frontend'),
    env: scrubEnvironment(process.env),
  }
}

function execute(invocation: Invocation, timeoutSeconds: number): boolean {
  process.stdout.write(`\n=== runTests: ${invocation.label} ===\n`)
  const outcome = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: 'inherit',
    timeout: timeoutSeconds * 1000,
  })
  if (outcome.error) {
    process.stdout.write(
      `runTests: ${invocation.label} could not run: ${outcome.error.message}\n`,
    )
    return false
  }
  if (outcome.signal) {
    process.stdout.write(
      `runTests: ${invocation.label} stopped by ${outcome.signal}\n`,
    )
    return false
  }
  return outcome.status === 0
}

const usage = `Usage (run from the repository root):
  node .claude/skills/run-and-verify-tests/scripts/runTests.ts frontend [--coverage] [--repeat <n>] [--match <name>] [test files...]
  node .claude/skills/run-and-verify-tests/scripts/runTests.ts backend  [--coverage] [--repeat <n>] [--match <expr>] [test files or node ids...]
  node .claude/skills/run-and-verify-tests/scripts/runTests.ts all [--coverage]
  node .claude/skills/run-and-verify-tests/scripts/runTests.ts typecheck
  node .claude/skills/run-and-verify-tests/scripts/runTests.ts format [--check] <frontend test files...>
Options: --out <dir under .testAgent/> (default .testAgent/coverage), --timeoutSeconds <n> (default 900)
`

export interface RunPlan {
  invocations: Invocation[]
  coverageDirectory: string | null
  coverageStacks: Array<'frontend' | 'backend'>
  timeoutSeconds: number
}

export function planInvocations(repoRoot: string, argv: string[]): RunPlan {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      coverage: { type: 'boolean', default: false },
      repeat: { type: 'string', default: '1' },
      match: { type: 'string' },
      out: { type: 'string', default: '.testAgent/coverage' },
      check: { type: 'boolean', default: false },
      timeoutSeconds: { type: 'string', default: '900' },
    },
  })
  const [command, ...files] = positionals
  const timeoutSeconds = Number(values.timeoutSeconds)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error('--timeoutSeconds must be a positive integer')
  }
  const repeat = Number(values.repeat)
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) {
    throw new Error('--repeat must be an integer between 1 and 5')
  }
  if (values.match) assertNotOption(values.match, '--match')
  const coverageDirectory = values.coverage
    ? resolveOutputDirectory(repoRoot, values.out)
    : null
  const suite = (stack: 'frontend' | 'backend', suiteFiles: string[]) => {
    const resolved = resolveTestFiles(repoRoot, suiteFiles, stack)
    const build = stack === 'frontend' ? frontendInvocation : backendInvocation
    return Array.from({ length: repeat }, (_, variant) =>
      build(repoRoot, {
        files: resolved,
        coverageDirectory: variant === 0 ? coverageDirectory : null,
        match: values.match ?? null,
        variant,
      }),
    )
  }
  const plan = (
    invocations: Invocation[],
    coverageStacks: RunPlan['coverageStacks'] = [],
  ): RunPlan => ({
    invocations,
    coverageDirectory: coverageStacks.length > 0 ? coverageDirectory : null,
    coverageStacks,
    timeoutSeconds,
  })
  switch (command) {
    case 'frontend':
    case 'backend':
      return plan(suite(command, files), [command])
    case 'all':
      if (files.length > 0) {
        throw new Error('"all" runs the full suites and takes no files')
      }
      return plan(
        [...suite('frontend', []), ...suite('backend', [])],
        ['frontend', 'backend'],
      )
    case 'typecheck':
      return plan([typecheckInvocation(repoRoot)])
    case 'format':
      if (files.length === 0)
        throw new Error('"format" needs at least one file')
      return plan([formatInvocation(repoRoot, files, values.check)])
    default:
      throw new Error(usage)
  }
}

function main(argv: string[]) {
  const repoRoot = path.resolve(import.meta.dirname, '../../../..')
  let plan: RunPlan
  try {
    plan = planInvocations(repoRoot, argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(64)
  }
  if (plan.coverageDirectory) {
    mkdirSync(path.join(plan.coverageDirectory, 'backend'), { recursive: true })
  }
  const failed = plan.invocations
    .filter((invocation) => !execute(invocation, plan.timeoutSeconds))
    .map((invocation) => invocation.label)
  if (plan.coverageDirectory) {
    const summary = readCoverageSummary(plan.coverageDirectory, repoRoot)
    if (!plan.coverageStacks.includes('frontend')) summary.frontend = null
    if (!plan.coverageStacks.includes('backend')) summary.backend = null
    writeFileSync(
      path.join(plan.coverageDirectory, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    for (const [stack, coverage] of Object.entries(summary)) {
      if (coverage) {
        process.stdout.write(
          `runTests: ${stack} coverage lines ${coverage.total.lines.pct}% branches ${coverage.total.branches.pct}%\n`,
        )
      }
    }
  }
  const passed = plan.invocations.length - failed.length
  process.stdout.write(
    `runTests: ${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}\n`,
  )
  process.exitCode = failed.length === 0 ? 0 : 1
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
