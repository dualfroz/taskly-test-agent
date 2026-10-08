import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const committablePatterns = [
  'frontend/src/**/*.test.ts',
  'frontend/src/**/*.test.tsx',
  'frontend/src/test/**/*.ts',
  'frontend/src/test/**/*.tsx',
  'frontend/src/design-system/mocks.tsx',
  'backend/tests/**/*.py',
]

export const scratchPatterns = ['.testAgent/**']

export type GuardDecision =
  { allowed: true } | { allowed: false; reason: string }

const writeTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === '*' && glob[index + 1] === '*') {
      const spansDirectories = glob[index + 2] === '/'
      source += spansDirectories ? '(?:[^/]+/)*' : '.*'
      index += spansDirectories ? 2 : 1
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath))
}

export function isCommittablePath(relativePath: string): boolean {
  return matchesAny(relativePath, committablePatterns)
}

export function isScratchPath(relativePath: string): boolean {
  return matchesAny(relativePath, scratchPatterns)
}

export function isWritablePath(relativePath: string): boolean {
  return isCommittablePath(relativePath) || isScratchPath(relativePath)
}

function resolvePhysicalPath(absolutePath: string): string {
  const missingSegments: string[] = []
  let current = absolutePath
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missingSegments.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (lstatSync(current, { throwIfNoEntry: false })) {
        throw new Error(`${current} is a dangling symbolic link`)
      }
      const parent = path.dirname(current)
      if (parent === current) throw error
      missingSegments.push(path.basename(current))
      current = parent
    }
  }
}

export function resolveRepoPath(
  repoRoot: string,
  filePath: string,
  baseDirectory: string = repoRoot,
): string | null {
  if (filePath.includes('\0')) return null
  if (filePath.split(/[\\/]/).includes('..')) return null
  const realRoot = realpathSync(repoRoot)
  const physicalPath = resolvePhysicalPath(
    path.resolve(baseDirectory, filePath),
  )
  const relativePath = path.relative(realRoot, physicalPath)
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null
  }
  return relativePath.split(path.sep).join('/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deny(reason: string): GuardDecision {
  return {
    allowed: false,
    reason: `Blocked by guardTestPaths: ${reason}. The unit-test-agent may only write ${[...committablePatterns, ...scratchPatterns].join(', ')}. Never change application code; report suspected product bugs as findings instead.`,
  }
}

export function evaluateToolCall(
  rawInput: string,
  projectDirectory: string | undefined,
): GuardDecision {
  let payload: unknown
  try {
    payload = JSON.parse(rawInput)
  } catch {
    return deny('hook input is not valid JSON')
  }
  if (!isRecord(payload) || typeof payload.tool_name !== 'string') {
    return deny('hook input has no tool_name')
  }
  if (!writeTools.has(payload.tool_name)) return { allowed: true }
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {}
  const filePath = toolInput.file_path ?? toolInput.notebook_path
  if (typeof filePath !== 'string' || filePath === '') {
    return deny('tool input has no file path')
  }
  const sessionDirectory =
    typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : null
  const repoRoot = projectDirectory || sessionDirectory
  if (!repoRoot) return deny('the project directory is unknown')
  let relativePath: string | null
  try {
    relativePath = resolveRepoPath(
      repoRoot,
      filePath,
      sessionDirectory ?? repoRoot,
    )
  } catch (error) {
    return deny(`${filePath} cannot be resolved (${(error as Error).message})`)
  }
  if (relativePath === null) {
    return deny(`${filePath} is outside the repository or uses ".."`)
  }
  if (!isWritablePath(relativePath)) {
    return deny(`${relativePath} is not a test file`)
  }
  return { allowed: true }
}
