import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parsePatch, testDeclarations, verifyPatch } from '../verifyPaths.ts'
import {
  createTempDirectory,
  fixturesDirectory,
  writeFiles,
} from './helpers.ts'

const samplePatch = readFileSync(
  path.join(fixturesDirectory, 'agentPatch.diff'),
  'utf8',
)

function verify(patch: string, maxBytes = 524288) {
  return verifyPatch(parsePatch(patch), Buffer.byteLength(patch), maxBytes)
}

function modifiedFile(filePath: string, hunk: string[]) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'index 1111111..2222222 100644',
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    ...hunk,
    '',
  ].join('\n')
}

describe('parsePatch', () => {
  it('reads files, statuses and changed lines of a git patch', () => {
    const files = parsePatch(samplePatch)
    assert.deepEqual(
      files.map((file) => [file.path, file.status]),
      [
        ['backend/tests/features/todos/test_router.py', 'modified'],
        ['frontend/src/lib/http.test.ts', 'added'],
      ],
    )
    assert.equal(files[0].addedLines.length, 7)
    assert.equal(files[0].removedLines.length, 0)
    assert.equal(files[1].newMode, '100644')
  })

  it('treats hunk lines that look like headers as content', () => {
    const files = parsePatch(
      modifiedFile('backend/tests/test_a.py', [
        '@@ -1,2 +1,2 @@',
        '--- old comment',
        '+++ new comment',
        ' unchanged',
      ]),
    )
    assert.deepEqual(files[0].removedLines, ['-- old comment'])
    assert.deepEqual(files[0].addedLines, ['++ new comment'])
    assert.equal(files[0].path, 'backend/tests/test_a.py')
  })
})

describe('verifyPatch', () => {
  it('accepts the sample agent patch and lists changed test files for the stability rerun', () => {
    const verification = verify(samplePatch)
    assert.equal(verification.ok, true)
    assert.deepEqual(verification.violations, [])
    assert.deepEqual(verification.changedTestFiles, {
      frontend: ['frontend/src/lib/http.test.ts'],
      backend: ['backend/tests/features/todos/test_router.py'],
    })
    assert.deepEqual(verification.files[0].testsAdded, [
      'test_get_returns_404_for_missing_task',
    ])
    assert.equal(verification.files[1].assertionsAdded, 1)
  })

  it('rejects application code, deletions, renames, binaries, symlinks and executables', () => {
    const patch = [
      modifiedFile('backend/app/main.py', ['@@ -1 +1 @@', '-a', '+b']),
      'diff --git a/backend/tests/test_old.py b/backend/tests/test_old.py\ndeleted file mode 100644\n--- a/backend/tests/test_old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
      'diff --git a/backend/tests/test_a.py b/backend/tests/test_b.py\nsimilarity index 100%\nrename from backend/tests/test_a.py\nrename to backend/tests/test_b.py\n',
      'diff --git a/frontend/src/test/logo.png.test.ts b/frontend/src/test/logo.png.test.ts\nnew file mode 100644\nGIT binary patch\nliteral 1\n',
      'diff --git a/frontend/src/test/link.ts b/frontend/src/test/link.ts\nnew file mode 120000\n--- /dev/null\n+++ b/frontend/src/test/link.ts\n@@ -0,0 +1 @@\n+../../app/main.py\n',
      'diff --git a/backend/tests/run.py b/backend/tests/run.py\nold mode 100644\nnew mode 100755\n',
    ].join('')
    const rules = verify(patch).violations.map(
      (violation) => `${violation.rule}:${violation.path}`,
    )
    assert.deepEqual(rules.sort(), [
      'binaryFile:frontend/src/test/logo.png.test.ts',
      'deletedFile:backend/tests/test_old.py',
      'fileMode:backend/tests/run.py',
      'fileMode:frontend/src/test/link.ts',
      'outsideAllowlist:backend/app/main.py',
      'renamedFile:backend/tests/test_b.py',
    ])
  })

  it('rejects quoted or unusual paths', () => {
    const patch =
      'diff --git "a/backend/tests/t\\303\\251st.py" "b/backend/tests/t\\303\\251st.py"\nnew file mode 100644\n'
    assert.deepEqual(
      verify(patch).violations.map((violation) => violation.rule),
      ['unusualPath'],
    )
  })

  it('rejects removed tests and new skip or focus markers but allows moved tests', () => {
    const patch = [
      modifiedFile('frontend/src/a.test.ts', [
        '@@ -1,6 +1,6 @@',
        "-it('keeps this name', () => {",
        "+it('keeps this name', async () => {",
        "-it('was deleted', () => {})",
        "+it.only('focus', () => {})",
        ' const x = 1',
        "-test('another', () => {})",
        "+it.skip('another', () => {})",
        ' const y = 2',
        ' const z = 3',
      ]),
      modifiedFile('backend/tests/test_b.py', [
        '@@ -1,1 +1,2 @@',
        ' import pytest',
        '+@pytest.mark.xfail',
      ]),
    ].join('')
    const verification = verify(patch)
    assert.deepEqual(
      verification.violations.map(
        (violation) => `${violation.rule}:${violation.detail}`,
      ),
      [
        'removedTest:existing test "was deleted" was removed or renamed',
        "skippedTest:skip/only/xfail marker added: it.only('focus', () => {})",
        "skippedTest:skip/only/xfail marker added: it.skip('another', () => {})",
        'skippedTest:skip/only/xfail marker added: @pytest.mark.xfail',
      ],
    )
  })

  it('warns when existing assertions are rewritten', () => {
    const patch = modifiedFile('backend/tests/test_a.py', [
      '@@ -1 +1 @@',
      '-    assert value == 2',
      '+    assert value >= 0',
    ])
    const verification = verify(patch)
    assert.equal(verification.ok, true)
    assert.deepEqual(
      verification.warnings.map((warning) => warning.rule),
      ['assertionsChanged'],
    )
  })

  it('rejects oversized patches', () => {
    assert.deepEqual(
      verify(samplePatch, 100).violations.map((violation) => violation.rule),
      ['patchTooLarge'],
    )
  })

  it('accepts an empty patch', () => {
    assert.deepEqual(verify(''), {
      ok: true,
      patchBytes: 0,
      files: [],
      violations: [],
      warnings: [],
      changedTestFiles: { frontend: [], backend: [] },
    })
  })
})

describe('testDeclarations', () => {
  it('reads test names from Vitest and pytest declarations', () => {
    assert.deepEqual(
      testDeclarations([
        "it('a', () => {})",
        'describe("b", () => {',
        "  test.each([1])('c %s', (n) => {})",
        'def test_d(client):',
        'async def test_e():',
        'def helper():',
      ]),
      ['a', 'b', 'c %s', 'test_d', 'test_e'],
    )
  })
})

describe('verifyPaths command line', () => {
  it('prints the verification and exits 1 on violations', () => {
    const directory = createTempDirectory()
    writeFiles(directory, {
      'bad.patch': modifiedFile('backend/app/main.py', [
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ]),
    })
    const outcome = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, '../verifyPaths.ts'),
        '--patch',
        path.join(directory, 'bad.patch'),
      ],
      { encoding: 'utf8' },
    )
    assert.equal(outcome.status, 1)
    assert.equal(
      JSON.parse(outcome.stdout).violations[0].rule,
      'outsideAllowlist',
    )
  })
})
