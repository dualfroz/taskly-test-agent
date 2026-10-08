import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type {
  ChangeSet,
  LineRange,
} from '../../analyze-pr-changes/scripts/changeSet.ts'

export interface Ratio {
  covered: number
  total: number
  pct: number
}

export interface FileCoverage {
  path: string
  lines: Ratio
  branches: Ratio
  missingLines: LineRange[]
}

export interface StackCoverage {
  total: { lines: Ratio; branches: Ratio }
  files: FileCoverage[]
}

export interface ChangedFileCoverage {
  path: string
  inReport: boolean
  linesPct: number | null
  uncoveredChangedLines: LineRange[]
}

export interface CoverageSummary {
  frontend: StackCoverage | null
  backend: StackCoverage | null
  changedFiles?: ChangedFileCoverage[]
}

interface IstanbulLocation {
  start: { line: number }
}

interface IstanbulFile {
  path: string
  statementMap: Record<string, IstanbulLocation>
  s: Record<string, number>
  b: Record<string, number[]>
}

interface CoveragePyFile {
  summary: {
    covered_lines: number
    num_statements: number
    covered_branches?: number
    num_branches?: number
  }
  missing_lines: number[]
}

interface CoveragePyReport {
  files: Record<string, CoveragePyFile>
}

export function ratio(covered: number, total: number): Ratio {
  const pct = total === 0 ? 100 : Math.floor((covered * 10000) / total) / 100
  return { covered, total, pct }
}

export function compressLines(lines: number[]): LineRange[] {
  const ranges: LineRange[] = []
  for (const line of [...new Set(lines)].sort((left, right) => left - right)) {
    const last = ranges.at(-1)
    if (last && line === last[1] + 1) last[1] = line
    else ranges.push([line, line])
  }
  return ranges
}

function totalOf(files: FileCoverage[]): StackCoverage['total'] {
  const sum = (pick: (file: FileCoverage) => Ratio) =>
    files.reduce(
      (accumulator, file) => ({
        covered: accumulator.covered + pick(file).covered,
        total: accumulator.total + pick(file).total,
      }),
      { covered: 0, total: 0 },
    )
  const lines = sum((file) => file.lines)
  const branches = sum((file) => file.branches)
  return {
    lines: ratio(lines.covered, lines.total),
    branches: ratio(branches.covered, branches.total),
  }
}

function toRepoPath(filePath: string, repoRoot: string): string {
  const relative = path.isAbsolute(filePath)
    ? path.relative(repoRoot, filePath)
    : filePath
  return relative.split(path.sep).join('/')
}

export function summarizeIstanbul(
  report: Record<string, IstanbulFile>,
  repoRoot: string,
): StackCoverage {
  const files = Object.values(report).map((file): FileCoverage => {
    const hitsByLine = new Map<number, number>()
    for (const [id, location] of Object.entries(file.statementMap)) {
      const line = location.start.line
      hitsByLine.set(line, Math.max(hitsByLine.get(line) ?? 0, file.s[id] ?? 0))
    }
    const lineHits = [...hitsByLine.values()]
    const branchHits = Object.values(file.b).flat()
    return {
      path: toRepoPath(file.path, repoRoot),
      lines: ratio(lineHits.filter((hits) => hits > 0).length, lineHits.length),
      branches: ratio(
        branchHits.filter((hits) => hits > 0).length,
        branchHits.length,
      ),
      missingLines: compressLines(
        [...hitsByLine].filter(([, hits]) => hits === 0).map(([line]) => line),
      ),
    }
  })
  return { total: totalOf(files), files: sortByMissing(files) }
}

export function summarizeCoveragePy(
  report: CoveragePyReport,
  pathPrefix: string,
): StackCoverage {
  const files = Object.entries(report.files).map(
    ([filePath, file]): FileCoverage => ({
      path: path.posix.join(pathPrefix, filePath.split(path.sep).join('/')),
      lines: ratio(file.summary.covered_lines, file.summary.num_statements),
      branches: ratio(
        file.summary.covered_branches ?? 0,
        file.summary.num_branches ?? 0,
      ),
      missingLines: compressLines(file.missing_lines),
    }),
  )
  return { total: totalOf(files), files: sortByMissing(files) }
}

function missingCount(file: FileCoverage): number {
  return file.missingLines.reduce(
    (count, [start, end]) => count + end - start + 1,
    0,
  )
}

function sortByMissing(files: FileCoverage[]): FileCoverage[] {
  return [...files].sort(
    (left, right) =>
      missingCount(right) - missingCount(left) ||
      left.path.localeCompare(right.path),
  )
}

export function intersectRanges(
  left: LineRange[],
  right: LineRange[],
): LineRange[] {
  const overlap: LineRange[] = []
  for (const [leftStart, leftEnd] of left) {
    for (const [rightStart, rightEnd] of right) {
      const start = Math.max(leftStart, rightStart)
      const end = Math.min(leftEnd, rightEnd)
      if (start <= end) overlap.push([start, end])
    }
  }
  return overlap.sort((first, second) => first[0] - second[0])
}

export function coverChangedFiles(
  summary: CoverageSummary,
  changeSet: ChangeSet,
): ChangedFileCoverage[] {
  const byPath = new Map(
    [...(summary.frontend?.files ?? []), ...(summary.backend?.files ?? [])].map(
      (file) => [file.path, file],
    ),
  )
  return changeSet.files
    .filter(
      (file) =>
        (file.area === 'frontendSource' || file.area === 'backendSource') &&
        file.status !== 'deleted',
    )
    .map((file) => {
      const coverage = byPath.get(file.path)
      return {
        path: file.path,
        inReport: coverage !== undefined,
        linesPct: coverage?.lines.pct ?? null,
        uncoveredChangedLines: coverage
          ? intersectRanges(coverage.missingLines, file.changedLines)
          : [],
      }
    })
}

export function readCoverageSummary(
  directory: string,
  repoRoot: string,
): CoverageSummary {
  const frontendReport = path.join(directory, 'frontend', 'coverage-final.json')
  const backendReport = path.join(directory, 'backend', 'coverage.json')
  return {
    frontend: existsSync(frontendReport)
      ? summarizeIstanbul(
          JSON.parse(readFileSync(frontendReport, 'utf8')),
          repoRoot,
        )
      : null,
    backend: existsSync(backendReport)
      ? summarizeCoveragePy(
          JSON.parse(readFileSync(backendReport, 'utf8')),
          'backend',
        )
      : null,
  }
}

export function limitFiles(
  summary: CoverageSummary,
  top: number,
): CoverageSummary {
  const limit = (stack: StackCoverage | null) =>
    stack && {
      ...stack,
      files: stack.files.filter((file) => missingCount(file) > 0).slice(0, top),
    }
  return {
    ...summary,
    frontend: limit(summary.frontend),
    backend: limit(summary.backend),
  }
}

function main(argv: string[]) {
  const repoRoot = path.resolve(import.meta.dirname, '../../../..')
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: '.testAgent/coverage' },
      changeSet: { type: 'string' },
      top: { type: 'string' },
    },
  })
  const summary = readCoverageSummary(
    path.resolve(repoRoot, values.dir),
    repoRoot,
  )
  if (values.changeSet) {
    const changeSet: ChangeSet = JSON.parse(
      readFileSync(path.resolve(repoRoot, values.changeSet), 'utf8'),
    )
    summary.changedFiles = coverChangedFiles(summary, changeSet)
  }
  const output = values.top ? limitFiles(summary, Number(values.top)) : summary
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
