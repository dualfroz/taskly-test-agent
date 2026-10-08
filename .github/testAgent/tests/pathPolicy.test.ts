import assert from 'node:assert/strict'
import { readFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  committablePatterns,
  evaluateToolCall,
  globToRegExp,
  isCommittablePath,
  isWritablePath,
  resolveRepoPath,
  scratchPatterns,
} from '../../../.claude/hooks/pathPolicy.ts'
import { createTempDirectory, repoRoot, writeFiles } from './helpers.ts'

function createRepo(): string {
  const root = createTempDirectory()
  writeFiles(root, {
    'frontend/src/features/todos/utils/todos.ts': 'export {}\n',
    'backend/app/main.py': '\n',
    'backend/tests/conftest.py': '\n',
  })
  return root
}

function toolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd?: string,
) {
  return JSON.stringify({
    session_id: 's',
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
  })
}

describe('globToRegExp', () => {
  it('lets ** span zero or more directories and * stay inside one segment', () => {
    const pattern = globToRegExp('frontend/src/**/*.test.ts')
    assert.ok(pattern.test('frontend/src/a.test.ts'))
    assert.ok(pattern.test('frontend/src/x/y/a.test.ts'))
    assert.ok(!pattern.test('frontend/src/a.test.tsx'))
    assert.ok(!pattern.test('frontend/a.test.ts'))
    assert.ok(!globToRegExp('backend/*.py').test('backend/app/main.py'))
  })

  it('escapes regular expression characters in literal parts', () => {
    assert.ok(globToRegExp('.testAgent/**').test('.testAgent/report.json'))
    assert.ok(!globToRegExp('.testAgent/**').test('xtestAgent/report.json'))
  })
})

describe('path allowlists', () => {
  it('accepts only test files and shared test helpers as committable', () => {
    for (const allowed of [
      'frontend/src/App.test.tsx',
      'frontend/src/lib/http.test.ts',
      'frontend/src/test/queryWrapper.tsx',
      'frontend/src/design-system/mocks.tsx',
      'backend/tests/conftest.py',
      'backend/tests/core/test_config.py',
    ]) {
      assert.ok(isCommittablePath(allowed), allowed)
    }
    for (const denied of [
      'frontend/src/App.tsx',
      'frontend/src/design-system/index.ts',
      'frontend/package.json',
      'frontend/vite.config.ts',
      'backend/app/main.py',
      'backend/pyproject.toml',
      'backend/tests/fixtures/data.json',
      '.github/workflows/ci.yml',
      '.claude/testAgent.settings.json',
      '.testAgent/notes.md',
    ]) {
      assert.ok(!isCommittablePath(denied), denied)
    }
  })

  it('adds the scratch directory only to the writable set', () => {
    assert.ok(isWritablePath('.testAgent/notes.md'))
    assert.ok(!isWritablePath('.testAgentx/notes.md'))
  })

  it('matches the Edit allow rules in .claude/testAgent.settings.json exactly', () => {
    const settings = JSON.parse(
      readFileSync(
        path.join(repoRoot, '.claude/testAgent.settings.json'),
        'utf8',
      ),
    )
    const editRules = (settings.permissions.allow as string[])
      .filter((rule) => rule.startsWith('Edit('))
      .map((rule) => rule.slice('Edit(./'.length, -1))
    assert.deepEqual(
      editRules.sort(),
      [...committablePatterns, ...scratchPatterns].sort(),
    )
  })
})

describe('resolveRepoPath', () => {
  it('normalizes absolute and relative paths to repository-relative POSIX paths', () => {
    const root = createRepo()
    assert.equal(
      resolveRepoPath(root, 'frontend/src/new.test.ts'),
      'frontend/src/new.test.ts',
    )
    assert.equal(
      resolveRepoPath(root, path.join(root, 'backend/tests/test_x.py')),
      'backend/tests/test_x.py',
    )
    assert.equal(
      resolveRepoPath(root, 'test_x.py', path.join(root, 'backend/tests')),
      'backend/tests/test_x.py',
    )
  })

  it('rejects parent segments, NUL bytes, the root itself and paths outside the repository', () => {
    const root = createRepo()
    assert.equal(resolveRepoPath(root, 'backend/tests/../app/main.py'), null)
    assert.equal(resolveRepoPath(root, 'backend/tests/x\0.py'), null)
    assert.equal(resolveRepoPath(root, root), null)
    assert.equal(resolveRepoPath(root, '/etc/passwd'), null)
  })

  it('follows symbolic links to their real target', () => {
    const root = createRepo()
    symlinkSync(
      path.join(root, 'backend/app'),
      path.join(root, 'backend/tests/linked'),
    )
    assert.equal(
      resolveRepoPath(root, 'backend/tests/linked/main.py'),
      'backend/app/main.py',
    )
    const outside = createTempDirectory()
    symlinkSync(outside, path.join(root, 'backend/tests/outside'))
    assert.equal(resolveRepoPath(root, 'backend/tests/outside/test_x.py'), null)
  })

  it('refuses a dangling symbolic link instead of trusting its name', () => {
    const root = createRepo()
    symlinkSync(
      path.join(root, 'backend/app/new_module.py'),
      path.join(root, 'backend/tests/test_trap.py'),
    )
    assert.throws(
      () => resolveRepoPath(root, 'backend/tests/test_trap.py'),
      /dangling symbolic link/,
    )
  })
})

describe('evaluateToolCall', () => {
  it('allows writes to test files and the scratch directory', () => {
    const root = createRepo()
    for (const filePath of [
      'frontend/src/lib/http.test.ts',
      path.join(root, 'backend/tests/core/test_config.py'),
      '.testAgent/plan.md',
    ]) {
      assert.deepEqual(
        evaluateToolCall(
          toolCall('Write', { file_path: filePath }, root),
          root,
        ),
        { allowed: true },
      )
    }
  })

  it('denies writes to application code, configuration and paths outside the repository', () => {
    const root = createRepo()
    for (const filePath of [
      'backend/app/main.py',
      'frontend/src/features/todos/utils/todos.ts',
      'frontend/package.json',
      '/tmp/x.test.ts',
      'backend/tests/../app/main.py',
    ]) {
      const decision = evaluateToolCall(
        toolCall(
          'Edit',
          { file_path: filePath, old_string: 'a', new_string: 'b' },
          root,
        ),
        root,
      )
      assert.equal(decision.allowed, false, filePath)
    }
  })

  it('checks notebook paths and MultiEdit like other writes', () => {
    const root = createRepo()
    assert.equal(
      evaluateToolCall(
        toolCall('NotebookEdit', { notebook_path: 'analysis.ipynb' }, root),
        root,
      ).allowed,
      false,
    )
    assert.equal(
      evaluateToolCall(
        toolCall(
          'MultiEdit',
          { file_path: 'backend/app/main.py', edits: [] },
          root,
        ),
        root,
      ).allowed,
      false,
    )
  })

  it('ignores tools that do not write files', () => {
    const root = createRepo()
    assert.deepEqual(
      evaluateToolCall(
        toolCall('Read', { file_path: '/etc/passwd' }, root),
        root,
      ),
      { allowed: true },
    )
  })

  it('fails closed on malformed or incomplete input', () => {
    const root = createRepo()
    for (const rawInput of [
      '',
      'not json',
      '[]',
      '{}',
      JSON.stringify({ tool_name: 'Write' }),
      toolCall('Write', { file_path: 42 }, root),
    ]) {
      assert.equal(evaluateToolCall(rawInput, root).allowed, false, rawInput)
    }
    assert.equal(
      evaluateToolCall(
        toolCall('Write', { file_path: 'frontend/src/a.test.ts' }),
        undefined,
      ).allowed,
      false,
    )
    assert.equal(
      evaluateToolCall(
        toolCall('Write', { file_path: 'frontend/src/a.test.ts' }, root),
        path.join(root, 'missing'),
      ).allowed,
      false,
    )
  })

  it('explains the allowlist in the denial reason', () => {
    const root = createRepo()
    const decision = evaluateToolCall(
      toolCall('Write', { file_path: 'backend/app/main.py' }, root),
      root,
    )
    assert.equal(decision.allowed, false)
    assert.match(
      decision.allowed ? '' : decision.reason,
      /backend\/app\/main\.py is not a test file.*backend\/tests\/\*\*\/\*\.py/,
    )
  })
})
