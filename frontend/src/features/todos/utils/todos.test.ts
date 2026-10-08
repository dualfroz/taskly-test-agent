import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDate, isOverdue, selectTodos, validateTodo } from './todos'
import type { Todo } from '../types'

const base: Todo = {
  id: 1,
  title: 'Sprint plan',
  description: '',
  priority: 'medium',
  completed: false,
  due_date: null,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
}

describe('selectTodos', () => {
  it('combines status with a case-insensitive search in the description', () => {
    const matching = { ...base, description: 'Discuss the API' }
    const todos = [
      matching,
      { ...matching, id: 2, completed: true },
      { ...base, id: 3 },
    ]
    expect(selectTodos(todos, 'active', ' api ', 'newest')).toEqual([matching])
  })

  it('sorts by priority without changing the source array', () => {
    const high: Todo = { ...base, id: 2, priority: 'high' }
    const todos = [base, high]
    expect(selectTodos(todos, 'all', '', 'priority')).toEqual([high, base])
    expect(todos).toEqual([base, high])
  })

  it('shows only completed tasks for the completed filter', () => {
    const done = { ...base, id: 2, completed: true }
    expect(selectTodos([base, done], 'completed', '', 'newest')).toEqual([done])
  })

  it('sorts by due date with undated tasks last and newer ids first on ties', () => {
    const late = { ...base, id: 1, due_date: '2026-11-01' }
    const soon = { ...base, id: 2, due_date: '2026-10-05' }
    const sameDayNewer = { ...base, id: 3, due_date: '2026-10-05' }
    const undated = { ...base, id: 4 }
    expect(
      selectTodos([undated, late, soon, sameDayNewer], 'all', '', 'due').map(
        (todo) => todo.id,
      ),
    ).toEqual([3, 2, 1, 4])
  })

  it('sorts newest first by creation time and breaks ties by id', () => {
    const older = { ...base, id: 1, created_at: '2026-09-01T12:00:00Z' }
    const newer = { ...base, id: 2, created_at: '2026-10-02T12:00:00Z' }
    const tie = { ...base, id: 3, created_at: '2026-10-02T12:00:00Z' }
    expect(
      selectTodos([older, newer, tie], 'all', '', 'newest').map((t) => t.id),
    ).toEqual([3, 2, 1])
  })

  it('breaks priority ties by newer id first', () => {
    const a = { ...base, id: 1 }
    const b = { ...base, id: 2 }
    expect(
      selectTodos([a, b], 'all', '', 'priority').map((todo) => todo.id),
    ).toEqual([2, 1])
  })
})

describe('validateTodo', () => {
  const valid = {
    title: 'Plan',
    description: '',
    priority: 'medium' as const,
    due_date: null,
    completed: false,
  }

  it('accepts a valid task', () => {
    expect(validateTodo(valid)).toEqual({})
  })

  it('rejects a whitespace-only title', () => {
    expect(validateTodo({ ...valid, title: '   ' })).toEqual({
      title: 'Enter a task title.',
    })
  })

  it('accepts a title of 120 characters and rejects 121', () => {
    expect(validateTodo({ ...valid, title: 'a'.repeat(120) })).toEqual({})
    expect(validateTodo({ ...valid, title: 'a'.repeat(121) })).toEqual({
      title: 'The title must be at most 120 characters.',
    })
  })

  it('accepts a description of 2000 characters and rejects 2001', () => {
    expect(validateTodo({ ...valid, description: 'a'.repeat(2000) })).toEqual(
      {},
    )
    expect(validateTodo({ ...valid, description: 'a'.repeat(2001) })).toEqual({
      description: 'The description must be at most 2000 characters.',
    })
  })

  it.each(['2026-02-30', '2026-13-01', '2026-1-01', 'tomorrow'])(
    'rejects the invalid due date %s',
    (due_date) => {
      expect(validateTodo({ ...valid, due_date })).toEqual({
        due_date: 'Enter a valid date.',
      })
    },
  )

  it('accepts a real leap day', () => {
    expect(validateTodo({ ...valid, due_date: '2028-02-29' })).toEqual({})
  })
})

describe('isOverdue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 10, 12))
  })
  afterEach(() => vi.useRealTimers())

  it('is overdue when the due date is before today', () => {
    expect(isOverdue({ ...base, due_date: '2026-10-09' })).toBe(true)
  })

  it('is not overdue on the due date itself or later', () => {
    expect(isOverdue({ ...base, due_date: '2026-10-10' })).toBe(false)
    expect(isOverdue({ ...base, due_date: '2026-10-11' })).toBe(false)
  })

  it('is not overdue without a due date', () => {
    expect(isOverdue(base)).toBe(false)
  })

  it('is never overdue once completed', () => {
    expect(
      isOverdue({ ...base, completed: true, due_date: '2026-01-01' }),
    ).toBe(false)
  })
})

describe('formatDate', () => {
  it('formats an ISO date in en-GB short style', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026')
  })
})
