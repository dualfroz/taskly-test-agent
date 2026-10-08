import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  assertSafeRef,
  buildChangeSet,
  showDiff,
} from '../../../.claude/skills/analyze-pr-changes/scripts/changeSet.ts'
import { createTempDirectory, writeFiles } from './helpers.ts'

describe('assertSafeRef', () => {
  it('accepts branch names, SHAs and relative refs and rejects option-like or range refs', () => {
    for (const ref of [
      'main',
      'origin/main',
      'HEAD~2',
      'a'.repeat(40),
      'feature/x-y_z',
    ]) {
      assert.equal(assertSafeRef(ref), ref)
    }
    for (const ref of ['--output=/tmp/x', '-p', 'main..HEAD', 'a b', '$(id)']) {
      assert.throws(() => assertSafeRef(ref), /unsafe git ref/)
    }
  })
})

describe('buildChangeSet on a real git history', () => {
  function git(root: string, ...args: string[]) {
    return execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    )
  }

  function createHistory() {
    const root = createTempDirectory()
    git(root, 'init', '--quiet', '--initial-branch=main')
    writeFiles(root, {
      'frontend/src/utils/math.ts':
        'export function add(a: number, b: number) {\n  return a + b\n}\n',
      'frontend/src/utils/math.test.ts': "import { add } from './math'\n",
      'frontend/src/legacy.ts': 'export const legacy = 1\n',
      'backend/app/core/config.py': 'def load():\n    return 1\n',
      'backend/tests/core/test_config.py': 'from app.core.config import load\n',
      'README.md': '# Demo\n',
    })
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'base')
    const base = git(root, 'rev-parse', 'HEAD').trim()
    git(root, 'switch', '--quiet', '-c', 'feature')
    writeFiles(root, {
      'frontend/src/utils/math.ts':
        'export function add(a: number, b: number) {\n  return a + b\n}\n\nexport function sub(a: number, b: number) {\n  return a - b\n}\n',
      'frontend/src/types.ts': 'export type Id = number\n',
      'backend/app/core/config.py': 'def load():\n    return 2\n',
      'README.md': '# Demo\n\nMore.\n',
    })
    unlinkSync(path.join(root, 'frontend/src/legacy.ts'))
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'feature')
    return { root, base }
  }

  it('reports status, areas, changed lines, convention tests and the agent gate counts', () => {
    const { root, base } = createHistory()
    const changeSet = buildChangeSet(root, 'main', 'feature')
    assert.equal(changeSet.mergeBase, base)
    const byPath = new Map(changeSet.files.map((file) => [file.path, file]))
    const math = byPath.get('frontend/src/utils/math.ts')
    assert.equal(math?.status, 'modified')
    assert.equal(math?.testCandidate, true)
    assert.deepEqual(math?.changedLines, [[4, 7]])
    assert.equal(math?.conventionTest, 'frontend/src/utils/math.test.ts')
    assert.equal(math?.conventionTestExists, true)
    assert.equal(byPath.get('frontend/src/types.ts')?.kind, 'types')
    assert.equal(byPath.get('frontend/src/types.ts')?.testCandidate, false)
    assert.equal(byPath.get('frontend/src/legacy.ts')?.status, 'deleted')
    assert.equal(byPath.get('frontend/src/legacy.ts')?.testCandidate, false)
    const config = byPath.get('backend/app/core/config.py')
    assert.deepEqual(config?.changedLines, [[2, 2]])
    assert.equal(config?.conventionTest, 'backend/tests/core/test_config.py')
    assert.equal(byPath.get('README.md')?.area, 'docs')
    assert.deepEqual(changeSet.testCandidates, { frontend: 1, backend: 1 })
    assert.equal(changeSet.counts.frontendSource, 3)
  })

  it('shows the merge-base diff for selected paths only', () => {
    const { root } = createHistory()
    const diff = showDiff(
      root,
      'main',
      'feature',
      ['backend/app/core/config.py'],
      3,
    )
    assert.match(diff, /^-    return 1$/m)
    assert.match(diff, /^\+    return 2$/m)
    assert.doesNotMatch(diff, /math\.ts/)
    assert.throws(
      () => showDiff(root, 'main', 'feature', ['--output=/tmp/x'], 3),
      /looks like an option/,
    )
  })
})
