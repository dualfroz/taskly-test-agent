import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { ChangeSet } from '../../../.claude/skills/analyze-pr-changes/scripts/changeSet.ts'
import {
  compressLines,
  coverChangedFiles,
  intersectRanges,
  limitFiles,
  ratio,
  readCoverageSummary,
  summarizeCoveragePy,
  summarizeIstanbul,
} from '../../../.claude/skills/run-and-verify-tests/scripts/coverageSummary.ts'
import {
  createTempDirectory,
  fixturesDirectory,
  writeFiles,
} from './helpers.ts'

function fixture(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDirectory, name), 'utf8'))
}

describe('ratio and ranges', () => {
  it('rounds percentages down to two decimals and treats empty totals as fully covered', () => {
    assert.deepEqual(ratio(60, 137), { covered: 60, total: 137, pct: 43.79 })
    assert.deepEqual(ratio(29, 100), { covered: 29, total: 100, pct: 29 })
    assert.deepEqual(ratio(0, 0), { covered: 0, total: 0, pct: 100 })
  })

  it('compresses unsorted line numbers into ranges', () => {
    assert.deepEqual(compressLines([5, 1, 2, 3, 9, 3]), [
      [1, 3],
      [5, 5],
      [9, 9],
    ])
  })

  it('intersects missing lines with changed lines', () => {
    assert.deepEqual(
      intersectRanges(
        [
          [1, 3],
          [10, 12],
        ],
        [[2, 11]],
      ),
      [
        [2, 3],
        [10, 11],
      ],
    )
    assert.deepEqual(intersectRanges([[1, 3]], [[4, 5]]), [])
  })
})

describe('summarizeIstanbul', () => {
  it('derives line coverage from statement start lines like istanbul does', () => {
    const summary = summarizeIstanbul(fixture('frontendCoverage.json'), '/repo')
    assert.deepEqual(summary.total, {
      lines: ratio(3, 5),
      branches: ratio(3, 4),
    })
    const http = summary.files[0]
    assert.equal(http.path, 'frontend/src/lib/http.ts')
    assert.deepEqual(http.lines, ratio(2, 4))
    assert.deepEqual(http.missingLines, [[4, 5]])
    assert.deepEqual(summary.files[1], {
      path: 'frontend/src/App.tsx',
      lines: ratio(1, 1),
      branches: ratio(0, 0),
      missingLines: [],
    })
  })
})

describe('summarizeCoveragePy', () => {
  it('prefixes paths with the backend directory and sorts by uncovered lines', () => {
    const summary = summarizeCoveragePy(
      fixture('backendCoverage.json'),
      'backend',
    )
    assert.deepEqual(summary.total, {
      lines: ratio(25, 42),
      branches: ratio(6, 6),
    })
    assert.deepEqual(
      summary.files.map((file) => file.path),
      [
        'backend/app/features/todos/router.py',
        'backend/app/api/dependencies.py',
      ],
    )
    assert.deepEqual(summary.files[0].missingLines, [
      [24, 27],
      [32, 35],
      [40, 42],
    ])
  })
})

describe('readCoverageSummary', () => {
  it('reads whichever stack reports exist', () => {
    const directory = createTempDirectory()
    writeFiles(directory, {
      'backend/coverage.json': readFileSync(
        path.join(fixturesDirectory, 'backendCoverage.json'),
        'utf8',
      ),
    })
    const summary = readCoverageSummary(directory, '/repo')
    assert.equal(summary.frontend, null)
    assert.equal(summary.backend?.total.lines.pct, 59.52)
  })
})

describe('coverChangedFiles', () => {
  it('reports uncovered changed lines for changed source files that are in the report', () => {
    const summary = {
      frontend: summarizeIstanbul(fixture('frontendCoverage.json'), '/repo'),
      backend: summarizeCoveragePy(fixture('backendCoverage.json'), 'backend'),
    }
    const changed = coverChangedFiles(
      summary,
      fixture('changeSet.json') as ChangeSet,
    )
    assert.deepEqual(changed, [
      {
        path: 'frontend/src/lib/http.ts',
        inReport: true,
        linesPct: 50,
        uncoveredChangedLines: [[4, 4]],
      },
      {
        path: 'backend/app/features/todos/router.py',
        inReport: true,
        linesPct: 62.06,
        uncoveredChangedLines: [
          [32, 35],
          [40, 41],
        ],
      },
      {
        path: 'frontend/src/features/todos/types.ts',
        inReport: false,
        linesPct: null,
        uncoveredChangedLines: [],
      },
    ])
  })
})

describe('limitFiles', () => {
  it('keeps only the top files that still have uncovered lines', () => {
    const summary = {
      frontend: summarizeIstanbul(fixture('frontendCoverage.json'), '/repo'),
      backend: null,
    }
    assert.deepEqual(
      limitFiles(summary, 5).frontend?.files.map((file) => file.path),
      ['frontend/src/lib/http.ts'],
    )
  })
})
