import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { ChangeSet } from '../../../.claude/skills/analyze-pr-changes/scripts/changeSet.ts'
import type {
  CoverageSummary,
  FileCoverage,
} from '../../../.claude/skills/run-and-verify-tests/scripts/coverageSummary.ts'
import { ratio } from '../../../.claude/skills/run-and-verify-tests/scripts/coverageSummary.ts'
import { computeDelta, delta, sourcePathsOf } from '../coverageDelta.ts'
import { fixturesDirectory } from './helpers.ts'

function file(filePath: string, covered: number, total: number): FileCoverage {
  return {
    path: filePath,
    lines: ratio(covered, total),
    branches: ratio(0, 0),
    missingLines: [],
  }
}

function summary(
  frontendFiles: FileCoverage[] | null,
  backendFiles: FileCoverage[] | null,
): CoverageSummary {
  const stack = (files: FileCoverage[] | null) => {
    if (!files) return null
    const covered = files.reduce((sum, entry) => sum + entry.lines.covered, 0)
    const total = files.reduce((sum, entry) => sum + entry.lines.total, 0)
    return {
      total: { lines: ratio(covered, total), branches: ratio(1, 2) },
      files,
    }
  }
  return { frontend: stack(frontendFiles), backend: stack(backendFiles) }
}

const before = summary(
  [file('frontend/src/lib/http.ts', 2, 10), file('frontend/src/App.tsx', 1, 1)],
  [file('backend/app/factory.py', 0, 8)],
)
const after = summary(
  [file('frontend/src/lib/http.ts', 9, 10), file('frontend/src/App.tsx', 1, 1)],
  [file('backend/app/factory.py', 8, 8)],
)

describe('delta', () => {
  it('computes rounded changes and keeps missing values as null', () => {
    assert.deepEqual(delta(47.68, 61.2), {
      before: 47.68,
      after: 61.2,
      change: 13.52,
    })
    assert.deepEqual(delta(null, 50), { before: null, after: 50, change: null })
  })
})

describe('computeDelta', () => {
  it('compares stack totals and lists files whose coverage changed when no change set is given', () => {
    const result = computeDelta(before, after, null)
    assert.deepEqual(result.stacks, [
      { stack: 'frontend', lines: delta(27.27, 90.9), branches: delta(50, 50) },
      { stack: 'backend', lines: delta(0, 100), branches: delta(50, 50) },
    ])
    assert.deepEqual(
      result.files.map((entry) => [entry.path, entry.lines.change]),
      [
        ['backend/app/factory.py', 100],
        ['frontend/src/lib/http.ts', 70],
      ],
    )
  })

  it('reports every changed source file, including ones without coverage data', () => {
    const changeSet = JSON.parse(
      readFileSync(path.join(fixturesDirectory, 'changeSet.json'), 'utf8'),
    ) as ChangeSet
    const focus = sourcePathsOf(changeSet)
    assert.deepEqual(focus, [
      'frontend/src/lib/http.ts',
      'backend/app/features/todos/router.py',
      'frontend/src/features/todos/types.ts',
    ])
    const result = computeDelta(before, after, focus)
    assert.deepEqual(result.files, [
      { path: 'frontend/src/lib/http.ts', lines: delta(20, 90) },
      {
        path: 'backend/app/features/todos/router.py',
        lines: delta(null, null),
      },
      {
        path: 'frontend/src/features/todos/types.ts',
        lines: delta(null, null),
      },
    ])
  })

  it('omits a stack that is missing on both sides', () => {
    const result = computeDelta(
      summary(null, [file('backend/app/x.py', 1, 2)]),
      summary(null, [file('backend/app/x.py', 2, 2)]),
      null,
    )
    assert.deepEqual(
      result.stacks.map((entry) => entry.stack),
      ['backend'],
    )
  })
})
