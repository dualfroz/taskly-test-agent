import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isCommittablePath } from '../../.claude/hooks/pathPolicy.ts'

export type PatchStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface PatchFile {
  path: string
  previousPath: string | null
  status: PatchStatus
  binary: boolean
  quotedPath: boolean
  newMode: string | null
  addedLines: string[]
  removedLines: string[]
}

export interface Violation {
  path: string
  rule: string
  detail: string
}

export interface FileReport {
  path: string
  status: PatchStatus
  testsAdded: string[]
  testsRemoved: string[]
  assertionsAdded: number
  assertionsRemoved: number
}

export interface Verification {
  ok: boolean
  patchBytes: number
  files: FileReport[]
  violations: Violation[]
  warnings: Violation[]
  changedTestFiles: { frontend: string[]; backend: string[] }
}

const safePath = /^[A-Za-z0-9._/@+-]+$/
const regularFileMode = '100644'
const declarationPatterns = [
  /^\s*[xf]?(?:it|test|describe)(?:\.(?:each\([^)]*\)|\w+))*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/,
  /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/,
]
const skipPatterns = [
  /\b(?:it|test|describe)\.(?:skip|only|todo|fails)\b/,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail)\s*\(/,
]
const assertionPattern =
  /\bexpect\s*\(|^\s*assert\b|\bpytest\.raises\b|\.assert_\w+\(/

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  const lines = patch.split('\n')
  let current: PatchFile | null = null
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const header = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(line)
    if (header || line.startsWith('diff --git ')) {
      const quoted = !header || header[2].startsWith('"')
      current = {
        path: header ? stripPrefix(header[2], 'b/') : line,
        previousPath: null,
        status: 'modified',
        binary: false,
        quotedPath: quoted,
        newMode: null,
        addedLines: [],
        removedLines: [],
      }
      files.push(current)
      index += 1
      continue
    }
    if (current === null) {
      index += 1
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      let oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1])
      let newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      index += 1
      while (index < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
        const body = lines[index]
        if (body.startsWith('+')) {
          current.addedLines.push(body.slice(1))
          newRemaining -= 1
        } else if (body.startsWith('-')) {
          current.removedLines.push(body.slice(1))
          oldRemaining -= 1
        } else if (!body.startsWith('\\')) {
          oldRemaining -= 1
          newRemaining -= 1
        }
        index += 1
      }
      continue
    }
    if (line.startsWith('new file mode ')) {
      current.status = 'added'
      current.newMode = line.slice('new file mode '.length)
    } else if (line.startsWith('deleted file mode ')) {
      current.status = 'deleted'
    } else if (line.startsWith('new mode ')) {
      current.newMode = line.slice('new mode '.length)
    } else if (line.startsWith('rename from ')) {
      current.status = 'renamed'
      current.previousPath = line.slice('rename from '.length)
    } else if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length)
    } else if (
      line === 'GIT binary patch' ||
      /^Binary files .* differ$/.test(line)
    ) {
      current.binary = true
    } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      current.path = stripPrefix(line.slice(4), 'b/')
    }
    index += 1
  }
  return files
}

export function testDeclarations(lines: string[]): string[] {
  const names: string[] = []
  for (const line of lines) {
    for (const pattern of declarationPatterns) {
      const match = pattern.exec(line)
      if (match) names.push(match[2] ?? match[1])
    }
  }
  return names
}

function countAssertions(lines: string[]): number {
  return lines.filter((line) => assertionPattern.test(line)).length
}

export function verifyPatch(
  files: PatchFile[],
  patchBytes: number,
  maxBytes: number,
): Verification {
  const violations: Violation[] = []
  const warnings: Violation[] = []
  const reject = (path: string, rule: string, detail: string) =>
    violations.push({ path, rule, detail })
  if (patchBytes > maxBytes) {
    reject(
      '*',
      'patchTooLarge',
      `patch has ${patchBytes} bytes, limit is ${maxBytes}`,
    )
  }
  const reports = files.map((file): FileReport => {
    for (const candidate of [file.path, file.previousPath]) {
      if (candidate === null) continue
      if (file.quotedPath || !safePath.test(candidate)) {
        reject(
          candidate,
          'unusualPath',
          'path contains characters outside [A-Za-z0-9._/@+-]',
        )
      } else if (!isCommittablePath(candidate)) {
        reject(
          candidate,
          'outsideAllowlist',
          'only test files and shared test helpers may change',
        )
      }
    }
    if (file.status === 'deleted')
      reject(file.path, 'deletedFile', 'the agent must not delete files')
    if (file.status === 'renamed')
      reject(file.path, 'renamedFile', 'the agent must not rename files')
    if (file.binary)
      reject(file.path, 'binaryFile', 'binary content is not allowed')
    if (file.newMode !== null && file.newMode !== regularFileMode) {
      reject(
        file.path,
        'fileMode',
        `mode ${file.newMode} is not a regular non-executable file`,
      )
    }
    const added = testDeclarations(file.addedLines)
    const removed = testDeclarations(file.removedLines)
    const testsRemoved = removed.filter((name) => !added.includes(name))
    for (const name of testsRemoved) {
      reject(
        file.path,
        'removedTest',
        `existing test "${name}" was removed or renamed`,
      )
    }
    for (const line of file.addedLines) {
      if (skipPatterns.some((pattern) => pattern.test(line))) {
        reject(
          file.path,
          'skippedTest',
          `skip/only/xfail marker added: ${line.trim()}`,
        )
      }
    }
    const assertionsRemoved = countAssertions(file.removedLines)
    if (file.status === 'modified' && assertionsRemoved > 0) {
      warnings.push({
        path: file.path,
        rule: 'assertionsChanged',
        detail: `${assertionsRemoved} existing assertion line(s) were rewritten or removed; review them`,
      })
    }
    return {
      path: file.path,
      status: file.status,
      testsAdded: added.filter((name) => !removed.includes(name)),
      testsRemoved,
      assertionsAdded: countAssertions(file.addedLines),
      assertionsRemoved,
    }
  })
  const present = files
    .filter((file) => file.status !== 'deleted')
    .map((file) => file.path)
  return {
    ok: violations.length === 0,
    patchBytes,
    files: reports,
    violations,
    warnings,
    changedTestFiles: {
      frontend: present.filter((path) =>
        /^frontend\/src\/.+\.test\.tsx?$/.test(path),
      ),
      backend: present.filter((path) =>
        /^backend\/tests\/(?:.+\/)?test_[^/]+\.py$/.test(path),
      ),
    },
  }
}

function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      patch: { type: 'string' },
      maxBytes: { type: 'string', default: '524288' },
    },
  })
  if (!values.patch) {
    process.stderr.write(
      'Usage: verifyPaths.ts --patch <file> [--maxBytes <n>]\n',
    )
    process.exit(64)
  }
  const patch = readFileSync(values.patch)
  const verification = verifyPatch(
    parsePatch(patch.toString('utf8')),
    patch.byteLength,
    Number(values.maxBytes),
  )
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`)
  process.exitCode = verification.ok ? 0 : 1
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
