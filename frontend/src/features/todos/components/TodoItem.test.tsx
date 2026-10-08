import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { TodoItem } from './TodoItem'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

it('shows an active task and forwards edit requests', async () => {
  const user = userEvent.setup()
  const onEdit = vi.fn()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onEdit={onEdit}
      onToggle={onToggle}
      onDelete={onDelete}
    />,
  )
  expect(screen.getByRole('heading', { name: todoFixture.title })).toBeVisible()
  expect(screen.getByText('To do')).toBeVisible()
  expect(screen.getByText('Medium')).toBeVisible()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await user.click(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  )
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onToggle).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
})

const noop = {
  onEdit: vi.fn(),
  onToggle: vi.fn(),
  onDelete: vi.fn(),
}

describe('TodoItem details', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 10, 12))
  })
  afterEach(() => vi.useRealTimers())

  it('shows a completed task with its description and a mark-as-active toggle', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const todo = {
      ...todoFixture,
      completed: true,
      description: 'Line one',
      priority: 'high' as const,
    }
    render(<TodoItem todo={todo} busy={false} {...noop} onToggle={onToggle} />)
    expect(screen.getByText('Completed')).toBeVisible()
    expect(screen.getByText('Line one')).toBeVisible()
    expect(screen.getByText('High')).toBeVisible()
    expect(screen.getByText('#7')).toBeVisible()
    const checkbox = screen.getByRole('checkbox', {
      name: `Mark as active: ${todo.title}`,
    })
    expect(checkbox).toBeChecked()
    await user.click(checkbox)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('does not render a description when it is empty', () => {
    render(<TodoItem todo={todoFixture} busy={false} {...noop} />)
    expect(screen.queryByText('Line one')).not.toBeInTheDocument()
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
  })

  it('flags an open task whose due date has passed', () => {
    const todo = { ...todoFixture, due_date: '2026-10-09' }
    render(<TodoItem todo={todo} busy={false} {...noop} />)
    expect(screen.getByText(/9 Oct 2026 · overdue/)).toBeVisible()
  })

  it('shows a future due date without the overdue marker', () => {
    const todo = { ...todoFixture, due_date: '2026-10-15' }
    render(<TodoItem todo={todo} busy={false} {...noop} />)
    expect(screen.getByText('15 Oct 2026')).toBeVisible()
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
  })

  it('does not flag a completed task as overdue', () => {
    const todo = { ...todoFixture, completed: true, due_date: '2026-10-09' }
    render(<TodoItem todo={todo} busy={false} {...noop} />)
    expect(screen.getByText('9 Oct 2026')).toBeVisible()
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
  })

  it('disables every action while busy and forwards delete otherwise', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    const { rerender } = render(
      <TodoItem todo={todoFixture} busy {...noop} onDelete={onDelete} />,
    )
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(
      screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
    ).toBeDisabled()
    const del = screen.getByRole('button', {
      name: `Delete: ${todoFixture.title}`,
    })
    expect(del).toBeDisabled()
    await user.click(del)
    expect(onDelete).not.toHaveBeenCalled()
    rerender(
      <TodoItem
        todo={todoFixture}
        busy={false}
        {...noop}
        onDelete={onDelete}
      />,
    )
    await user.click(del)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
