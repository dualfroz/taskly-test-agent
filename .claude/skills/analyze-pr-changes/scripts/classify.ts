import path from 'node:path'
import { isCommittablePath, matchesAny } from '../../../hooks/pathPolicy.ts'

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed'
export type Area =
  'frontendSource' | 'backendSource' | 'test' | 'config' | 'docs' | 'other'
export type LineRange = [number, number]

export interface NameStatusEntry {
  status: FileStatus
  path: string
  previousPath: string | null
}

const testAreaPatterns = ['backend/tests/**', 'frontend/src/test/**']
const docsPatterns = ['**/*.md', 'docs/**']
const configPatterns = [
  '.github/**',
  '.claude/**',
  'scripts/**',
  '**/package.json',
  '**/package-lock.json',
  '**/tsconfig*.json',
  '**/vite.config.*',
  '**/vitest.config.*',
  'frontend/.storybook/**',
  '**/Dockerfile',
  '**/.dockerignore',
  '**/*.toml',
  '**/*.ini',
  '**/*.yaml',
  '**/*.yml',
  'backend/requirements*',
  '**/.gitignore',
  '**/.env.example',
  '**/nginx.conf',
  '**/.prettier*',
  '**/.npmrc',
]
const frontendCandidateKinds = new Set(['module'])
const backendCandidateKinds = new Set(['module', 'declarative'])
const declarativeModules = new Set([
  'schemas.py',
  'models.py',
  'types.py',
  'constants.py',
])

export function parseNameStatus(output: string): NameStatusEntry[] {
  const tokens = output.split('\0').filter((token) => token !== '')
  const entries: NameStatusEntry[] = []
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index]
    if (code.startsWith('R')) {
      entries.push({
        status: 'renamed',
        previousPath: tokens[index + 1],
        path: tokens[index + 2],
      })
      index += 3
      continue
    }
    const status: FileStatus =
      code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
    entries.push({ status, path: tokens[index + 1], previousPath: null })
    index += 2
  }
  return entries
}

export function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  const merged: LineRange[] = []
  for (const [start, end] of sorted) {
    const last = merged.at(-1)
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

export function parseChangedLines(unifiedDiff: string): LineRange[] {
  const ranges: LineRange[] = []
  for (const match of unifiedDiff.matchAll(
    /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
  )) {
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (count > 0) ranges.push([start, start + count - 1])
  }
  return mergeRanges(ranges)
}

export function hasRuntimeDeclarations(source: string): boolean {
  return (
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|enum)\b/m.test(
      source,
    ) || /^\s*export\s+default\b/m.test(source)
  )
}

export function frontendKind(filePath: string, source: string): string {
  const name = path.posix.basename(filePath)
  if (/\.stories\.tsx?$/.test(name)) return 'story'
  if (/\.styles\.ts$/.test(name) || name.endsWith('.css')) return 'styles'
  if (!/\.tsx?$/.test(name)) return 'asset'
  if (name === 'main.tsx') return 'entrypoint'
  const declaresRuntime = hasRuntimeDeclarations(source)
  if (/^index\.tsx?$/.test(name) && !declaresRuntime) return 'barrel'
  if (
    (name === 'types.ts' ||
      /\.types\.ts$/.test(name) ||
      name.endsWith('.d.ts')) &&
    !declaresRuntime
  ) {
    return 'types'
  }
  if (
    /^constants\.tsx?$/.test(name) ||
    /\.(?:constants|variants)\.ts$/.test(name)
  ) {
    return 'constants'
  }
  return 'module'
}

export function backendKind(filePath: string, source: string): string {
  const name = path.posix.basename(filePath)
  if (name === '__init__.py')
    return source.trim() === '' ? 'packageInit' : 'module'
  if (name === 'main.py') return 'entrypoint'
  if (declarativeModules.has(name)) return 'declarative'
  return 'module'
}

export function classifyPath(
  filePath: string,
  source: string,
): { area: Area; kind: string } {
  if (isCommittablePath(filePath) || matchesAny(filePath, testAreaPatterns)) {
    return { area: 'test', kind: 'test' }
  }
  if (filePath.startsWith('frontend/src/')) {
    return { area: 'frontendSource', kind: frontendKind(filePath, source) }
  }
  if (filePath.startsWith('backend/app/') && filePath.endsWith('.py')) {
    return { area: 'backendSource', kind: backendKind(filePath, source) }
  }
  if (matchesAny(filePath, docsPatterns)) return { area: 'docs', kind: 'docs' }
  if (matchesAny(filePath, configPatterns))
    return { area: 'config', kind: 'config' }
  return { area: 'other', kind: 'other' }
}

export function conventionTestPaths(filePath: string, area: Area): string[] {
  if (area === 'frontendSource') {
    const match = /^(.*)\.(tsx?)$/.exec(filePath)
    if (!match) return []
    const primary = `${match[1]}.test.${match[2]}`
    const alternative = `${match[1]}.test.${match[2] === 'ts' ? 'tsx' : 'ts'}`
    return [primary, alternative]
  }
  if (area === 'backendSource') {
    const relative = path.posix.relative('backend/app', filePath)
    const directory = path.posix.dirname(relative)
    const name = `test_${path.posix.basename(relative)}`
    return [path.posix.join('backend/tests', directory, name)]
  }
  return []
}

function frontendImportTargets(testPath: string, source: string): Set<string> {
  const targets = new Set<string>()
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bvi\.mock\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(testPath), specifier),
    )
    for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      targets.add(`${resolved}${suffix}`)
    }
  }
  return targets
}

function backendImportTargets(source: string): Set<string> {
  const targets = new Set<string>()
  const addModule = (moduleName: string) => {
    const base = `backend/${moduleName.replace(/\./g, '/')}`
    targets.add(`${base}.py`)
    targets.add(`${base}/__init__.py`)
  }
  for (const match of source.matchAll(
    /^\s*from\s+(app(?:\.\w+)*)\s+import\s+(\([^)]*\)|[^\n]+)/gm,
  )) {
    addModule(match[1])
    for (const name of match[2].replace(/[()]/g, ' ').split(',')) {
      const imported = name.trim().split(/\s+/)[0]
      if (/^\w+$/.test(imported)) addModule(`${match[1]}.${imported}`)
    }
  }
  for (const match of source.matchAll(/^\s*import\s+(app(?:\.\w+)*)/gm)) {
    addModule(match[1])
  }
  return targets
}

export function findRelatedTests(
  sourcePath: string,
  area: Area,
  testSources: Map<string, string>,
): string[] {
  const related: string[] = []
  for (const [testPath, source] of testSources) {
    const targets =
      area === 'frontendSource'
        ? frontendImportTargets(testPath, source)
        : backendImportTargets(source)
    if (targets.has(sourcePath)) related.push(testPath)
  }
  return related.sort()
}

export function isTestFile(filePath: string): boolean {
  return (
    /^frontend\/src\/.+\.test\.tsx?$/.test(filePath) ||
    /^backend\/tests\/(?:.+\/)?test_[^/]+\.py$/.test(filePath)
  )
}

export function isTestCandidate(
  area: Area,
  kind: string,
  status: FileStatus,
): boolean {
  if (status === 'deleted') return false
  if (area === 'frontendSource') return frontendCandidateKinds.has(kind)
  if (area === 'backendSource') return backendCandidateKinds.has(kind)
  return false
}
