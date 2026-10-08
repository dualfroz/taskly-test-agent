import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createTempDirectory, repoRoot } from './helpers.ts'

const settings = JSON.parse(
  readFileSync(path.join(repoRoot, '.claude/testAgent.settings.json'), 'utf8'),
)
const hookEntry = settings.hooks.PreToolUse[0]
const hookCommand: string = hookEntry.hooks[0].command

function runHook(input: string, projectDirectory = repoRoot) {
  return spawnSync('sh', ['-c', hookCommand], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: projectDirectory },
  })
}

function writeCall(filePath: string) {
  return JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: '' },
    cwd: repoRoot,
  })
}

describe('guardTestPaths hook as configured in .claude/testAgent.settings.json', () => {
  it('is registered for every file writing tool', () => {
    assert.equal(hookEntry.matcher, 'Edit|Write|MultiEdit|NotebookEdit')
  })

  it('exits 0 for a test file', () => {
    const outcome = runHook(
      writeCall('frontend/src/features/todos/hooks/useTodosQuery.test.tsx'),
    )
    assert.equal(outcome.status, 0, outcome.stderr)
  })

  it('exits 2 with a reason for application code', () => {
    const outcome = runHook(
      writeCall(path.join(repoRoot, 'backend/app/main.py')),
    )
    assert.equal(outcome.status, 2)
    assert.match(outcome.stderr, /backend\/app\/main\.py is not a test file/)
  })

  it('exits 2 for malformed input', () => {
    assert.equal(runHook('{').status, 2)
  })

  it('still blocks when the hook script itself cannot run', () => {
    const outcome = runHook(
      writeCall('frontend/src/a.test.ts'),
      createTempDirectory(),
    )
    assert.equal(outcome.status, 2)
  })
})
