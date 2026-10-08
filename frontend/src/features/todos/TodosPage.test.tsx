import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../test/todoFixture'
import type { Todo } from './types'
import { useNotice } from '../../hooks/useNotice'
import { useTodoFilters } from './hooks/useTodoFilters'
import { useTodosBusy } from './hooks/useTodosBusy'
import { useTodosQuery } from './hooks/useTodosQuery'
import { useUpdateTodoMutation } from './hooks/useUpdateTodoMutation'
import { TodosPage } from './TodosPage'

vi.mock('../../design-system', () => import('../../design-system/mocks'))
vi.mock('../../hooks/useNotice', () => ({ useNotice: vi.fn() }))
vi.mock('./hooks/useTodoFilters', () => ({ useTodoFilters: vi.fn() }))
vi.mock('./hooks/useTodosBusy', () => ({ useTodosBusy: vi.fn() }))
vi.mock('./hooks/useTodosQuery', () => ({ useTodosQuery: vi.fn() }))
vi.mock('./hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))
vi.mock('./components/TodosHeader', () => ({
  TodosHeader: ({
    disabled,
    onCreate,
  }: {
    disabled: boolean
    onCreate: () => void
  }) => (
    <>
      <h1>Tasks</h1>
      <button disabled={disabled} onClick={onCreate}>
        New task
      </button>
    </>
  ),
}))
vi.mock('./components/TodoFilters', () => ({
  TodoFilters: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('./components/ClearCompletedButton', () => ({
  ClearCompletedButton: ({
    count,
    busy,
    onCleared,
  }: {
    count: number
    busy: boolean
    onCleared: (deleted: number) => void
  }) => (
    <div>
      <p>
        Completed {count} busy {String(busy)}
      </p>
      <button onClick={() => onCleared(1)}>Cleared one</button>
      <button onClick={() => onCleared(4)}>Cleared four</button>
    </div>
  ),
}))
vi.mock('./components/TodoList', () => ({
  TodoList: ({
    todos,
    onCreate,
    onToggle,
    onEdit,
    onDelete,
  }: {
    todos: Todo[]
    onCreate: () => void
    onToggle: (todo: Todo) => void
    onEdit: (todo: Todo) => void
    onDelete: (todo: Todo) => void
  }) => (
    <div>
      <p>Task list</p>
      <button onClick={onCreate}>Empty create</button>
      {todos.map((todo) => (
        <div key={todo.id}>
          <button onClick={() => onToggle(todo)}>Toggle {todo.title}</button>
          <button onClick={() => onEdit(todo)}>Edit {todo.title}</button>
          <button onClick={() => onDelete(todo)}>Delete {todo.title}</button>
        </div>
      ))}
    </div>
  ),
}))
vi.mock('./components/TodoEditor', () => ({
  TodoEditor: ({
    todo,
    onClose,
    onSaved,
  }: {
    todo: Todo | 'new'
    onClose: () => void
    onSaved: (notice: string) => void
  }) => (
    <section aria-label="Editor">
      <p>{todo === 'new' ? 'Creating' : `Editing ${todo.title}`}</p>
      <button onClick={onClose}>Close editor</button>
      <button onClick={() => onSaved('Task created.')}>Save editor</button>
    </section>
  ),
}))
vi.mock('./components/DeleteTodoDialog', () => ({
  DeleteTodoDialog: ({
    todo,
    onClose,
    onDeleted,
  }: {
    todo: Todo
    onClose: () => void
    onDeleted: () => void
  }) => (
    <section aria-label="Delete dialog">
      <p>Deleting {todo.title}</p>
      <button onClick={onClose}>Close delete</button>
      <button onClick={onDeleted}>Confirm delete</button>
    </section>
  ),
}))
vi.mock('../../components/SuccessNotice', () => ({ SuccessNotice: () => null }))

it('displays a query failure and resets mutation errors before retrying', async () => {
  const user = userEvent.setup()
  const refetch = vi.fn().mockResolvedValue(undefined)
  const reset = vi.fn()
  vi.mocked(useTodosQuery).mockReturnValue({
    data: [],
    isPending: false,
    isFetching: false,
    isError: true,
    error: new Error('The server is unavailable.'),
    refetch,
  } as unknown as ReturnType<typeof useTodosQuery>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    error: null,
    reset,
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  vi.mocked(useTodosBusy).mockReturnValue(false)
  vi.mocked(useNotice).mockReturnValue({ message: '', notify: vi.fn() })
  vi.mocked(useTodoFilters).mockReturnValue({
    filter: 'all',
    search: '',
    sort: 'newest',
    visible: [],
    setFilter: vi.fn(),
    setSearch: vi.fn(),
    setSort: vi.fn(),
  })
  render(<TodosPage />)
  expect(screen.getByTestId('alert')).toHaveTextContent(
    'The server is unavailable.',
  )
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
  expect(reset).toHaveBeenCalledTimes(1)
  expect(reset.mock.invocationCallOrder[0]).toBeLessThan(
    refetch.mock.invocationCallOrder[0],
  )
})

function arrange({
  busy = false,
  todos = [todoFixture],
  mutateAsync = vi.fn(),
  mutationError = null as Error | null,
} = {}) {
  const notify = vi.fn()
  vi.mocked(useTodosQuery).mockReturnValue({
    data: todos,
    isPending: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useTodosQuery>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    error: mutationError,
    reset: vi.fn(),
    mutateAsync,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  vi.mocked(useTodosBusy).mockReturnValue(busy)
  vi.mocked(useNotice).mockReturnValue({ message: '', notify })
  vi.mocked(useTodoFilters).mockReturnValue({
    filter: 'all',
    search: '',
    sort: 'newest',
    visible: todos,
    setFilter: vi.fn(),
    setSearch: vi.fn(),
    setSort: vi.fn(),
  })
  return { notify, mutateAsync }
}

const toggleName = `Toggle ${todoFixture.title}`
const editName = `Edit ${todoFixture.title}`
const deleteName = `Delete ${todoFixture.title}`

beforeEach(() => vi.clearAllMocks())

it('toggles a task and congratulates the user when it becomes complete', async () => {
  const user = userEvent.setup()
  const mutateAsync = vi
    .fn()
    .mockResolvedValue({ ...todoFixture, completed: true })
  const { notify } = arrange({ mutateAsync })
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: toggleName }))
  expect(mutateAsync).toHaveBeenCalledWith({
    id: todoFixture.id,
    input: { completed: true },
  })
  expect(notify).toHaveBeenCalledWith('Another task complete. Well done!')
})

it('reports a reopened task as active', async () => {
  const user = userEvent.setup()
  const done = { ...todoFixture, completed: true }
  const mutateAsync = vi.fn().mockResolvedValue({ ...done, completed: false })
  const { notify } = arrange({ mutateAsync, todos: [done] })
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: toggleName }))
  expect(mutateAsync).toHaveBeenCalledWith({
    id: done.id,
    input: { completed: false },
  })
  expect(notify).toHaveBeenCalledWith('Task marked as active.')
})

it('shows no success notice when toggling fails', async () => {
  const user = userEvent.setup()
  const mutateAsync = vi.fn().mockRejectedValue(new Error('boom'))
  const { notify } = arrange({ mutateAsync })
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: toggleName }))
  expect(mutateAsync).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
})

it('shows the toggle error in the alert', () => {
  arrange({ mutationError: new Error('Could not save.') })
  render(<TodosPage />)
  expect(screen.getByTestId('alert')).toHaveTextContent('Could not save.')
})

it('ignores toggles and disables creation while another operation is running', async () => {
  const user = userEvent.setup()
  const { mutateAsync } = arrange({ busy: true })
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: toggleName }))
  expect(mutateAsync).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
})

it('opens the editor for a new task from the header and the empty list', async () => {
  const user = userEvent.setup()
  arrange()
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: 'New task' }))
  expect(screen.getByText('Creating')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Close editor' }))
  expect(screen.queryByText('Creating')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Empty create' }))
  expect(screen.getByText('Creating')).toBeVisible()
})

it('edits a task and announces the notice after saving closes the editor', async () => {
  const user = userEvent.setup()
  const { notify } = arrange()
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: editName }))
  expect(screen.getByText('Editing Prepare a demo')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Save editor' }))
  expect(screen.queryByText('Editing Prepare a demo')).not.toBeInTheDocument()
  expect(notify).toHaveBeenCalledWith('Task created.')
})

it('opens the delete confirmation and can dismiss it silently', async () => {
  const user = userEvent.setup()
  const { notify } = arrange()
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: deleteName }))
  expect(screen.getByText('Deleting Prepare a demo')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Close delete' }))
  expect(screen.queryByText('Deleting Prepare a demo')).not.toBeInTheDocument()
  expect(notify).not.toHaveBeenCalled()
})

it('passes the completed count to the clear button and announces the result', async () => {
  const user = userEvent.setup()
  const done = { ...todoFixture, id: 8, completed: true }
  const { notify } = arrange({ todos: [todoFixture, done] })
  render(<TodosPage />)
  expect(screen.getByText('Completed 1 busy false')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Cleared four' }))
  expect(notify).toHaveBeenCalledWith('Removed 4 completed tasks.')
  await user.click(screen.getByRole('button', { name: 'Cleared one' }))
  expect(notify).toHaveBeenCalledWith('Removed 1 completed task.')
})

it('marks the clear button busy while another operation runs', () => {
  arrange({ busy: true })
  render(<TodosPage />)
  expect(screen.getByText('Completed 0 busy true')).toBeVisible()
})

it('closes the delete dialog and announces the deletion', async () => {
  const user = userEvent.setup()
  const { notify } = arrange()
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: deleteName }))
  await user.click(screen.getByRole('button', { name: 'Confirm delete' }))
  expect(screen.queryByText('Deleting Prepare a demo')).not.toBeInTheDocument()
  expect(notify).toHaveBeenCalledWith('Task deleted.')
})
