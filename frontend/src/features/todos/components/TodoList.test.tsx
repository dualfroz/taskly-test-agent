import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { TodoList } from './TodoList'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('./TodoEmptyState', () => ({
  TodoEmptyState: () => <p>Empty task list</p>,
}))
vi.mock('./TodoItem', () => ({
  TodoItem: ({
    todo,
    busy,
    onToggle,
    onEdit,
    onDelete,
  }: {
    todo: Todo
    busy: boolean
    onToggle: () => void
    onEdit: () => void
    onDelete: () => void
  }) => (
    <li>
      Task {todo.title} {busy ? 'busy' : 'idle'}
      <button onClick={onToggle}>Toggle</button>
      <button onClick={onEdit}>Edit</button>
      <button onClick={onDelete}>Delete</button>
    </li>
  ),
}))

it('shows loading feedback before showing an empty list', () => {
  const props = {
    todos: [],
    hasTodos: false,
    failed: false,
    busy: false,
    onCreate: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }
  const { rerender } = render(<TodoList {...props} loading />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading your tasks…')
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
  rerender(<TodoList {...props} loading={false} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByText('Empty task list')).toBeVisible()
})

const baseProps = {
  todos: [] as Todo[],
  hasTodos: false,
  loading: false,
  failed: false,
  busy: false,
  onCreate: vi.fn(),
  onToggle: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
}

it('shows an unavailable message when loading failed and nothing is cached', () => {
  render(<TodoList {...baseProps} failed />)
  expect(
    screen.getByRole('heading', {
      name: 'The task list is temporarily unavailable',
    }),
  ).toBeVisible()
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
})

it('keeps showing cached tasks when a refresh failed', () => {
  render(<TodoList {...baseProps} failed hasTodos todos={[todoFixture]} />)
  expect(screen.getByText(/Task Prepare a demo/)).toBeVisible()
  expect(screen.queryByRole('heading')).not.toBeInTheDocument()
})

it('renders each task and binds the callbacks to that task', async () => {
  const user = userEvent.setup()
  const second = { ...todoFixture, id: 8, title: 'Second' }
  const props = {
    ...baseProps,
    hasTodos: true,
    busy: true,
    todos: [todoFixture, second],
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }
  render(<TodoList {...props} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByText(/Task Second busy/)).toBeVisible()
  await user.click(screen.getAllByRole('button', { name: 'Toggle' })[1])
  await user.click(screen.getAllByRole('button', { name: 'Edit' })[0])
  await user.click(screen.getAllByRole('button', { name: 'Delete' })[1])
  expect(props.onToggle).toHaveBeenCalledWith(second)
  expect(props.onEdit).toHaveBeenCalledWith(todoFixture)
  expect(props.onDelete).toHaveBeenCalledWith(second)
})
