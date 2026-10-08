import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  backendInvocation,
  formatInvocation,
  frontendInvocation,
  planInvocations,
  resolveOutputDirectory,
  resolveTestFiles,
  scrubEnvironment,
  variantLabel,
} from '../../../.claude/skills/run-and-verify-tests/scripts/runTests.ts'
import { createTempDirectory, writeFiles } from './helpers.ts'

function createRepo(): string {
  const root = createTempDirectory()
  writeFiles(root, {
    'frontend/src/lib/http.ts': '',
    'frontend/src/lib/http.test.ts': '',
    'backend/tests/core/test_config.py': '',
    'backend/app/main.py': '',
  })
  return root
}

describe('scrubEnvironment', () => {
  it('keeps only the allowlisted variables and never forwards credentials', () => {
    const environment = scrubEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/runner',
        ANTHROPIC_API_KEY: 'secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'secret',
        GITHUB_TOKEN: 'secret',
        NODE_OPTIONS: '--require /tmp/evil.js',
      },
      { TZ: 'Pacific/Kiritimati' },
    )
    assert.deepEqual(environment, {
      PATH: '/usr/bin',
      HOME: '/home/runner',
      NO_COLOR: '1',
      TZ: 'Pacific/Kiritimati',
    })
  })
})

describe('resolveTestFiles', () => {
  it('accepts existing test files and pytest node ids', () => {
    const root = createRepo()
    assert.deepEqual(
      resolveTestFiles(
        root,
        [path.join(root, 'frontend/src/lib/http.test.ts')],
        'frontend',
      ),
      ['frontend/src/lib/http.test.ts'],
    )
    assert.deepEqual(
      resolveTestFiles(
        root,
        [
          path.join(root, 'backend/tests/core/test_config.py') +
            '::test_x[a-b]',
        ],
        'backend',
      ),
      ['backend/tests/core/test_config.py::test_x[a-b]'],
    )
  })

  it('rejects source files, missing files, other stacks and option-like arguments', () => {
    const root = createRepo()
    const rejected: [string, 'frontend' | 'backend'][] = [
      [path.join(root, 'frontend/src/lib/http.ts'), 'frontend'],
      [path.join(root, 'frontend/src/lib/missing.test.ts'), 'frontend'],
      [path.join(root, 'backend/tests/core/test_config.py'), 'frontend'],
      [path.join(root, 'backend/app/main.py'), 'backend'],
      ['--config=/tmp/evil.ts', 'frontend'],
      [path.join(root, 'frontend/src/lib/http.test.ts') + '::name', 'frontend'],
    ]
    for (const [file, stack] of rejected) {
      assert.throws(() => resolveTestFiles(root, [file], stack), file)
    }
  })
})

describe('resolveOutputDirectory', () => {
  it('only allows directories below .testAgent', () => {
    const root = createRepo()
    assert.equal(
      resolveOutputDirectory(root, path.join(root, '.testAgent/after')),
      path.join(root, '.testAgent/after'),
    )
    for (const directory of [
      'frontend/src',
      '.testAgent',
      path.join(root, '..'),
      '/tmp',
    ]) {
      assert.throws(
        () => resolveOutputDirectory(root, directory),
        /subdirectory of \.testAgent/,
        directory,
      )
    }
  })
})

describe('invocations', () => {
  it('builds the frontend command with coverage reporters, shuffling and a name filter', () => {
    const root = createRepo()
    const invocation = frontendInvocation(root, {
      files: ['frontend/src/lib/http.test.ts'],
      coverageDirectory: path.join(root, '.testAgent/coverage'),
      match: 'maps 422',
      variant: 2,
    })
    assert.equal(
      invocation.command,
      path.join(root, 'frontend/node_modules/.bin/vitest'),
    )
    assert.equal(invocation.cwd, path.join(root, 'frontend'))
    assert.deepEqual(invocation.args, [
      'run',
      '--sequence.shuffle',
      '--sequence.seed=2',
      '--testNamePattern',
      'maps 422',
      '--coverage.enabled=true',
      '--coverage.reporter=json',
      '--coverage.reporter=json-summary',
      '--coverage.reporter=text-summary',
      `--coverage.reportsDirectory=${path.join(root, '.testAgent/coverage/frontend')}`,
      'src/lib/http.test.ts',
    ])
    assert.equal(invocation.env.TZ, 'Pacific/Pago_Pago')
  })

  it('builds the backend command with branch coverage written under the output directory', () => {
    const root = createRepo()
    const invocation = backendInvocation(root, {
      files: ['backend/tests/core/test_config.py::test_x'],
      coverageDirectory: path.join(root, '.testAgent/coverage'),
      match: null,
      variant: 0,
    })
    assert.equal(
      invocation.command,
      path.join(root, 'backend/.venv/bin/python'),
    )
    assert.equal(invocation.cwd, path.join(root, 'backend'))
    assert.deepEqual(invocation.args, [
      '-m',
      'pytest',
      '-p',
      'no:cacheprovider',
      '-q',
      '--cov=app',
      '--cov-branch',
      `--cov-report=json:${path.join(root, '.testAgent/coverage/backend/coverage.json')}`,
      '--cov-report=term-missing:skip-covered',
      'tests/core/test_config.py::test_x',
    ])
    assert.equal(
      invocation.env.COVERAGE_FILE,
      path.join(root, '.testAgent/coverage/backend/.coverage'),
    )
    assert.equal(invocation.env.TZ, process.env.TZ)
  })

  it('formats only frontend test files', () => {
    const root = createRepo()
    assert.deepEqual(
      formatInvocation(
        root,
        [path.join(root, 'frontend/src/lib/http.test.ts')],
        true,
      ).args,
      ['--check', 'src/lib/http.test.ts'],
    )
    assert.throws(
      () =>
        formatInvocation(
          root,
          [path.join(root, 'frontend/src/lib/http.ts')],
          false,
        ),
      /Only existing frontend test files/,
    )
    assert.throws(
      () =>
        formatInvocation(
          root,
          [path.join(root, 'backend/tests/core/test_config.py')],
          false,
        ),
      /Only existing frontend test files/,
    )
  })

  it('describes the variants used for stability reruns', () => {
    assert.equal(variantLabel(0), 'default order and time zone')
    assert.equal(variantLabel(1), 'TZ=Pacific/Kiritimati, shuffled with seed 1')
  })
})

describe('planInvocations', () => {
  it('repeats a selection with coverage collected only on the first run', () => {
    const root = createRepo()
    const plan = planInvocations(root, [
      'backend',
      '--repeat',
      '3',
      '--coverage',
      '--out',
      path.join(root, '.testAgent/after'),
      path.join(root, 'backend/tests/core/test_config.py'),
    ])
    assert.equal(plan.invocations.length, 3)
    assert.deepEqual(plan.coverageStacks, ['backend'])
    assert.ok(plan.invocations[0].args.includes('--cov=app'))
    assert.ok(!plan.invocations[1].args.includes('--cov=app'))
    assert.deepEqual(
      plan.invocations.map((invocation) => invocation.env.TZ ?? 'inherited'),
      [
        process.env.TZ ?? 'inherited',
        'Pacific/Kiritimati',
        'Pacific/Pago_Pago',
      ],
    )
  })

  it('runs both full suites for "all" and rejects file arguments there', () => {
    const root = createRepo()
    const plan = planInvocations(root, ['all'])
    assert.deepEqual(
      plan.invocations.map((invocation) => invocation.label),
      [
        'frontend tests (default order and time zone)',
        'backend tests (default order and time zone)',
      ],
    )
    assert.equal(plan.coverageDirectory, null)
    assert.throws(
      () => planInvocations(root, ['all', 'frontend/src/lib/http.test.ts']),
      /takes no files/,
    )
  })

  it('validates numeric options and the command', () => {
    const root = createRepo()
    assert.throws(
      () => planInvocations(root, ['frontend', '--repeat', '9']),
      /--repeat/,
    )
    assert.throws(
      () => planInvocations(root, ['frontend', '--timeoutSeconds', 'soon']),
      /--timeoutSeconds/,
    )
    assert.throws(
      () => planInvocations(root, ['frontend', '--match=--reporter=json']),
      /--match/,
    )
    assert.throws(() => planInvocations(root, ['deploy']), /Usage/)
    assert.equal(
      planInvocations(root, ['typecheck']).invocations[0].label,
      'frontend typecheck',
    )
  })
})
