import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  classifyPath,
  conventionTestPaths,
  findRelatedTests,
  isTestCandidate,
  isTestFile,
  parseChangedLines,
  parseNameStatus,
  type Area,
  type LineRange,
  type NameStatusEntry,
} from './classify.ts'

export type { Area, FileStatus, LineRange } from './classify.ts'

export interface ChangedFile extends NameStatusEntry {
  area: Area
  kind: string
  testCandidate: boolean
  changedLines: LineRange[]
  conventionTest: string | null
  conventionTestExists: boolean
  relatedTests: string[]
}

export interface ChangeSet {
  base: string
  head: string
  mergeBase: string
  headCommit: string
  files: ChangedFile[]
  counts: Record<Area, number>
  testCandidates: { frontend: number; backend: number }
}

const safeRef = /^(?!-)(?!.*\.\.)[\w./^~@{}-]+$/

function createGit(repoRoot: string) {
  return (args: string[]) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
}

export function assertSafeRef(ref: string): string {
  if (!safeRef.test(ref)) throw new Error(`Refusing unsafe git ref: ${ref}`)
  return ref
}

export function buildChangeSet(
  repoRoot: string,
  base: string,
  head: string,
): ChangeSet {
  const git = createGit(repoRoot)
  const headCommit = git([
    'rev-parse',
    '--verify',
    `${assertSafeRef(head)}^{commit}`,
  ]).trim()
  const baseCommit = git([
    'rev-parse',
    '--verify',
    `${assertSafeRef(base)}^{commit}`,
  ]).trim()
  const mergeBase = git(['merge-base', baseCommit, headCommit]).trim()
  const entries = parseNameStatus(
    git([
      'diff',
      '--name-status',
      '-z',
      '-M',
      '--no-ext-diff',
      '--no-textconv',
      mergeBase,
      headCommit,
    ]),
  )
  const headFiles = new Set(
    git(['ls-tree', '-r', '--name-only', '-z', headCommit])
      .split('\0')
      .filter(Boolean),
  )
  const readAtHead = (filePath: string) =>
    headFiles.has(filePath) ? git(['show', `${headCommit}:${filePath}`]) : ''
  const testSources = new Map(
    [...headFiles]
      .filter(isTestFile)
      .map((testPath) => [testPath, readAtHead(testPath)]),
  )
  const counts: Record<Area, number> = {
    frontendSource: 0,
    backendSource: 0,
    test: 0,
    config: 0,
    docs: 0,
    other: 0,
  }
  const files = entries.map((entry): ChangedFile => {
    const source = entry.status === 'deleted' ? '' : readAtHead(entry.path)
    const { area, kind } = classifyPath(entry.path, source)
    counts[area] += 1
    const pathspec = entry.previousPath
      ? [entry.previousPath, entry.path]
      : [entry.path]
    const changedLines =
      entry.status === 'deleted'
        ? []
        : parseChangedLines(
            git([
              'diff',
              '-U0',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              '-M',
              mergeBase,
              headCommit,
              '--',
              ...pathspec,
            ]),
          )
    const candidates = conventionTestPaths(entry.path, area)
    const existing = candidates.find((candidate) => headFiles.has(candidate))
    const conventionTest = existing ?? candidates[0] ?? null
    const isSource = area === 'frontendSource' || area === 'backendSource'
    return {
      ...entry,
      area,
      kind,
      testCandidate: isTestCandidate(area, kind, entry.status),
      changedLines,
      conventionTest,
      conventionTestExists: existing !== undefined,
      relatedTests: isSource
        ? findRelatedTests(entry.path, area, testSources).filter(
            (testPath) => testPath !== conventionTest,
          )
        : [],
    }
  })
  return {
    base,
    head,
    mergeBase,
    headCommit,
    files,
    counts,
    testCandidates: {
      frontend: files.filter(
        (file) => file.testCandidate && file.area === 'frontendSource',
      ).length,
      backend: files.filter(
        (file) => file.testCandidate && file.area === 'backendSource',
      ).length,
    },
  }
}

export function showDiff(
  repoRoot: string,
  base: string,
  head: string,
  paths: string[],
  context: number,
): string {
  const git = createGit(repoRoot)
  for (const filePath of paths) {
    if (filePath.startsWith('-'))
      throw new Error(`Refusing path that looks like an option: ${filePath}`)
  }
  const headCommit = git([
    'rev-parse',
    '--verify',
    `${assertSafeRef(head)}^{commit}`,
  ]).trim()
  const mergeBase = git(['merge-base', assertSafeRef(base), headCommit]).trim()
  return git([
    'diff',
    `-U${context}`,
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '-M',
    mergeBase,
    headCommit,
    '--',
    ...paths,
  ])
}

function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      repo: { type: 'string' },
      context: { type: 'string', default: '5' },
    },
  })
  const [command, ...paths] = positionals
  const repoRoot =
    values.repo ?? path.resolve(import.meta.dirname, '../../../..')
  if (!values.base || (command !== 'files' && command !== 'diff')) {
    process.stderr.write(
      'Usage: changeSet.ts files --base <ref> [--head <ref>]\n       changeSet.ts diff --base <ref> [--head <ref>] [--context <n>] [paths...]\n',
    )
    process.exit(64)
  }
  if (command === 'files') {
    const changeSet = buildChangeSet(repoRoot, values.base, values.head)
    process.stdout.write(`${JSON.stringify(changeSet, null, 2)}\n`)
    return
  }
  const context = Number(values.context)
  if (!Number.isInteger(context) || context < 0 || context > 50) {
    throw new Error('--context must be an integer between 0 and 50')
  }
  process.stdout.write(
    showDiff(repoRoot, values.base, values.head, paths, context),
  )
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
