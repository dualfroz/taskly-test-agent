import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { todoFixture } from '../../../test/todoFixture'
import { useCreateTodoMutation } from './useCreateTodoMutation'
import { useDeleteTodoMutation } from './useDeleteTodoMutation'
import { useTodoFilters } from './useTodoFilters'
import { useTodosBusy } from './useTodosBusy'
import { useTodosQuery } from './useTodosQuery'
import { useUpdateTodoMutation } from './useUpdateTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

const other = { ...todoFixture, id: 8, title: 'Other' }

beforeEach(() => vi.clearAllMocks())

describe('useCreateTodoMutation', () => {
  it('puts a created task first and drops a stale copy', async () => {
    const { client, wrapper } = setup()
    const saved = { ...other, title: 'Saved' }
    client.setQueryData(todoKeys.list, [todoFixture, other])
    vi.mocked(todosApi.create).mockResolvedValue(saved)
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(saved))
    expect(todosApi.create).toHaveBeenCalledWith(saved)
    expect(client.getQueryData(todoKeys.list)).toEqual([saved, todoFixture])
  })

  it('creates the list when nothing is cached yet', async () => {
    const { client, wrapper } = setup()
    vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(todoFixture))
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })

  it('leaves the cache untouched when creation fails', async () => {
    const { client, wrapper } = setup()
    client.setQueryData(todoKeys.list, [todoFixture])
    vi.mocked(todosApi.create).mockRejectedValue(new Error('nope'))
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(other).catch(() => undefined))
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })
})

describe('useUpdateTodoMutation', () => {
  it('replaces the matching task in the cache', async () => {
    const { client, wrapper } = setup()
    const saved = { ...todoFixture, completed: true }
    client.setQueryData(todoKeys.list, [other, todoFixture])
    vi.mocked(todosApi.update).mockResolvedValue(saved)
    const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })
    await act(() =>
      result.current.mutateAsync({ id: 7, input: { completed: true } }),
    )
    expect(todosApi.update).toHaveBeenCalledWith(7, { completed: true })
    expect(client.getQueryData(todoKeys.list)).toEqual([other, saved])
  })

  it('does not create a list when nothing is cached', async () => {
    const { client, wrapper } = setup()
    vi.mocked(todosApi.update).mockResolvedValue(todoFixture)
    const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync({ id: 7, input: {} }))
    expect(client.getQueryData(todoKeys.list)).toBeUndefined()
  })
})

describe('useDeleteTodoMutation', () => {
  it('removes the deleted task from the cache', async () => {
    const { client, wrapper } = setup()
    client.setQueryData(todoKeys.list, [todoFixture, other])
    vi.mocked(todosApi.remove).mockResolvedValue(undefined)
    const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(7))
    expect(todosApi.remove).toHaveBeenCalledWith(7)
    expect(client.getQueryData(todoKeys.list)).toEqual([other])
  })

  it('does not create a list when nothing is cached', async () => {
    const { client, wrapper } = setup()
    vi.mocked(todosApi.remove).mockResolvedValue(undefined)
    const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(7))
    expect(client.getQueryData(todoKeys.list)).toBeUndefined()
  })
})

describe('useTodosQuery', () => {
  it('loads tasks and forwards the abort signal', async () => {
    const { wrapper } = setup()
    vi.mocked(todosApi.list).mockResolvedValue([todoFixture])
    const { result } = renderHook(() => useTodosQuery(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([todoFixture])
    expect(vi.mocked(todosApi.list).mock.calls[0][0]).toBeInstanceOf(
      AbortSignal,
    )
  })
})

describe('useTodosBusy', () => {
  it('is busy while a todo mutation is pending and idle afterwards', async () => {
    const { client, wrapper } = setup()
    let release: (value: typeof todoFixture) => void = () => undefined
    vi.mocked(todosApi.create).mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const { result } = renderHook(
      () => ({ busy: useTodosBusy(), create: useCreateTodoMutation() }),
      { wrapper },
    )
    expect(result.current.busy).toBe(false)
    let pending: Promise<unknown> = Promise.resolve()
    act(() => {
      pending = result.current.create.mutateAsync(todoFixture)
    })
    await waitFor(() => expect(result.current.busy).toBe(true))
    await act(async () => {
      release(todoFixture)
      await pending
    })
    await waitFor(() => expect(result.current.busy).toBe(false))
    client.clear()
  })
})

describe('useTodoFilters', () => {
  it('starts with all tasks, no search and newest first', () => {
    const { result } = renderHook(() => useTodoFilters([todoFixture, other]))
    expect(result.current.filter).toBe('all')
    expect(result.current.search).toBe('')
    expect(result.current.sort).toBe('newest')
    expect(result.current.visible.map((todo) => todo.id)).toEqual([8, 7])
  })

  it('applies the filter, search and sort that were set', () => {
    const done = { ...other, completed: true, title: 'Ship it' }
    const { result } = renderHook(() => useTodoFilters([todoFixture, done]))
    act(() => result.current.setFilter('completed'))
    expect(result.current.visible).toEqual([done])
    act(() => result.current.setFilter('all'))
    act(() => result.current.setSearch('demo'))
    expect(result.current.visible).toEqual([todoFixture])
    act(() => result.current.setSearch(''))
    act(() => result.current.setSort('priority'))
    expect(result.current.sort).toBe('priority')
  })
})
