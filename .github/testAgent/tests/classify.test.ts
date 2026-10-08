import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifyPath,
  conventionTestPaths,
  findRelatedTests,
  hasRuntimeDeclarations,
  isTestCandidate,
  mergeRanges,
  parseChangedLines,
  parseNameStatus,
} from '../../../.claude/skills/analyze-pr-changes/scripts/classify.ts'

describe('parseNameStatus', () => {
  it('reads NUL separated status entries including renames', () => {
    const output = [
      'M',
      'a.ts',
      'A',
      'b.ts',
      'D',
      'c.ts',
      'R087',
      'old.ts',
      'new.ts',
      'T',
      'd.ts',
      '',
    ].join('\0')
    assert.deepEqual(parseNameStatus(output), [
      { status: 'modified', path: 'a.ts', previousPath: null },
      { status: 'added', path: 'b.ts', previousPath: null },
      { status: 'deleted', path: 'c.ts', previousPath: null },
      { status: 'renamed', path: 'new.ts', previousPath: 'old.ts' },
      { status: 'modified', path: 'd.ts', previousPath: null },
    ])
  })
})

describe('changed line ranges', () => {
  it('turns zero-context hunks into merged head line ranges and ignores pure deletions', () => {
    const diff = [
      '@@ -3,0 +4,2 @@',
      '+a',
      '+b',
      '@@ -10 +12 @@',
      '-x',
      '+y',
      '@@ -20,3 +21,0 @@',
      '@@ -30,1 +13,1 @@',
    ].join('\n')
    assert.deepEqual(parseChangedLines(diff), [
      [4, 5],
      [12, 13],
    ])
  })

  it('merges overlapping and adjacent ranges', () => {
    assert.deepEqual(
      mergeRanges([
        [10, 12],
        [1, 2],
        [3, 4],
        [11, 15],
      ]),
      [
        [1, 4],
        [10, 15],
      ],
    )
  })
})

describe('classifyPath', () => {
  const cases: [string, string, string, string][] = [
    [
      'frontend/src/features/todos/utils/todos.ts',
      'export function f() {}',
      'frontendSource',
      'module',
    ],
    [
      'frontend/src/features/todos/types.ts',
      'export type A = 1\nexport interface B {}',
      'frontendSource',
      'types',
    ],
    [
      'frontend/src/features/todos/types.ts',
      'export const limit = 3',
      'frontendSource',
      'module',
    ],
    [
      'frontend/src/features/todos/index.ts',
      "export { TodosPage } from './TodosPage'",
      'frontendSource',
      'barrel',
    ],
    [
      'frontend/src/features/todos/index.ts',
      "export { TodosPage } from './TodosPage'\nexport function helper() {}",
      'frontendSource',
      'module',
    ],
    [
      'frontend/src/design-system/components/Button/Button.styles.ts',
      '',
      'frontendSource',
      'styles',
    ],
    [
      'frontend/src/design-system/components/Button/Button.stories.tsx',
      '',
      'frontendSource',
      'story',
    ],
    [
      'frontend/src/design-system/components/Badge/Badge.variants.ts',
      '',
      'frontendSource',
      'constants',
    ],
    ['frontend/src/main.tsx', '', 'frontendSource', 'entrypoint'],
    ['frontend/src/styles.css', '', 'frontendSource', 'styles'],
    ['frontend/src/App.test.tsx', '', 'test', 'test'],
    ['frontend/src/test/todoFixture.ts', '', 'test', 'test'],
    ['frontend/src/design-system/mocks.tsx', '', 'test', 'test'],
    ['backend/app/features/todos/router.py', '', 'backendSource', 'module'],
    [
      'backend/app/features/todos/schemas.py',
      '',
      'backendSource',
      'declarative',
    ],
    ['backend/app/__init__.py', '', 'backendSource', 'packageInit'],
    ['backend/app/main.py', '', 'backendSource', 'entrypoint'],
    ['backend/tests/fixtures/data.json', '', 'test', 'test'],
    ['README.md', '', 'docs', 'docs'],
    ['frontend/package.json', '', 'config', 'config'],
    ['.github/workflows/ci.yml', '', 'config', 'config'],
    ['backend/requirements.txt', '', 'config', 'config'],
    ['frontend/index.html', '', 'other', 'other'],
  ]
  for (const [filePath, source, area, kind] of cases) {
    it(`classifies ${filePath} as ${area}/${kind}`, () => {
      assert.deepEqual(classifyPath(filePath, source), { area, kind })
    })
  }

  it('detects runtime declarations that make a declaration file testable', () => {
    assert.ok(hasRuntimeDeclarations('export default function App() {}'))
    assert.ok(hasRuntimeDeclarations('export enum Mode { A }'))
    assert.ok(!hasRuntimeDeclarations("export type { Todo } from './types'"))
  })
})

describe('conventionTestPaths', () => {
  it('maps frontend modules to colocated tests and backend modules to the mirrored tests package', () => {
    assert.deepEqual(
      conventionTestPaths('frontend/src/lib/http.ts', 'frontendSource'),
      ['frontend/src/lib/http.test.ts', 'frontend/src/lib/http.test.tsx'],
    )
    assert.deepEqual(
      conventionTestPaths('frontend/src/App.tsx', 'frontendSource'),
      ['frontend/src/App.test.tsx', 'frontend/src/App.test.ts'],
    )
    assert.deepEqual(
      conventionTestPaths('backend/app/core/config.py', 'backendSource'),
      ['backend/tests/core/test_config.py'],
    )
    assert.deepEqual(
      conventionTestPaths('backend/app/factory.py', 'backendSource'),
      ['backend/tests/test_factory.py'],
    )
    assert.deepEqual(conventionTestPaths('README.md', 'docs'), [])
  })
})

describe('findRelatedTests', () => {
  it('finds frontend tests that import or mock the module', () => {
    const tests = new Map([
      [
        'frontend/src/features/todos/components/TodoList.test.tsx',
        "vi.mock('./TodoItem', () => ({}))\nimport { TodoList } from './TodoList'",
      ],
      [
        'frontend/src/features/todos/TodosPage.test.tsx',
        "import { TodosPage } from './TodosPage'",
      ],
    ])
    assert.deepEqual(
      findRelatedTests(
        'frontend/src/features/todos/components/TodoItem.tsx',
        'frontendSource',
        tests,
      ),
      ['frontend/src/features/todos/components/TodoList.test.tsx'],
    )
  })

  it('finds backend tests importing the module, including parenthesized and submodule imports', () => {
    const tests = new Map([
      [
        'backend/tests/test_a.py',
        'from app.features.todos.schemas import (\n    Todo,\n    TodoCreate,\n)\n',
      ],
      [
        'backend/tests/test_b.py',
        'from app.features.todos import repository\n',
      ],
      ['backend/tests/test_c.py', 'import app.core.config\n'],
    ])
    assert.deepEqual(
      findRelatedTests(
        'backend/app/features/todos/schemas.py',
        'backendSource',
        tests,
      ),
      ['backend/tests/test_a.py'],
    )
    assert.deepEqual(
      findRelatedTests(
        'backend/app/features/todos/repository.py',
        'backendSource',
        tests,
      ),
      ['backend/tests/test_b.py'],
    )
    assert.deepEqual(
      findRelatedTests('backend/app/core/config.py', 'backendSource', tests),
      ['backend/tests/test_c.py'],
    )
  })
})

describe('isTestCandidate', () => {
  it('lets only non-deleted behaviour-carrying source files start the agent', () => {
    assert.equal(isTestCandidate('frontendSource', 'module', 'modified'), true)
    assert.equal(isTestCandidate('frontendSource', 'types', 'modified'), false)
    assert.equal(isTestCandidate('frontendSource', 'module', 'deleted'), false)
    assert.equal(isTestCandidate('backendSource', 'declarative', 'added'), true)
    assert.equal(
      isTestCandidate('backendSource', 'entrypoint', 'modified'),
      false,
    )
    assert.equal(isTestCandidate('test', 'test', 'added'), false)
  })
})
