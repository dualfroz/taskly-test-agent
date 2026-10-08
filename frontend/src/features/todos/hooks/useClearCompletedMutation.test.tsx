import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useClearCompletedMutation } from './useClearCompletedMutation'

vi.mock('../api/todos', () => ({ todosApi: { clearCompleted: vi.fn() } }))
beforeEach(() => vi.clearAllMocks())

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

it('clears completed tasks and invalidates the task list', async () => {
  const { client, wrapper } = setup()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  vi.mocked(todosApi.clearCompleted).mockResolvedValue({ deleted: 2 })
  const { result } = renderHook(() => useClearCompletedMutation(), { wrapper })
  await act(async () => {
    await expect(result.current.mutateAsync()).resolves.toEqual({ deleted: 2 })
  })
  expect(todosApi.clearCompleted).toHaveBeenCalledTimes(1)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: todoKeys.list })
})

it('does not invalidate the list when clearing fails', async () => {
  const { client, wrapper } = setup()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  vi.mocked(todosApi.clearCompleted).mockRejectedValue(new Error('boom'))
  const { result } = renderHook(() => useClearCompletedMutation(), { wrapper })
  await act(async () => {
    await expect(result.current.mutateAsync()).rejects.toThrow('boom')
  })
  expect(invalidate).not.toHaveBeenCalled()
})
