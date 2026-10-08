import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { useClearCompletedMutation } from '../hooks/useClearCompletedMutation'
import { ClearCompletedButton } from './ClearCompletedButton'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useClearCompletedMutation', () => ({
  useClearCompletedMutation: vi.fn(),
}))
beforeEach(() => vi.clearAllMocks())

function arrange({ isPending = false, error = null as Error | null } = {}) {
  const mutate = vi.fn()
  vi.mocked(useClearCompletedMutation).mockReturnValue({
    isPending,
    error,
    mutate,
  } as unknown as ReturnType<typeof useClearCompletedMutation>)
  return { mutate }
}

it('shows the count and clears completed tasks, reporting the deleted total', async () => {
  const user = userEvent.setup()
  const onCleared = vi.fn()
  const { mutate } = arrange()
  render(<ClearCompletedButton count={3} busy={false} onCleared={onCleared} />)
  await user.click(screen.getByRole('button', { name: 'Clear completed (3)' }))
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(mutate.mock.calls[0][0]).toBeUndefined()
  mutate.mock.calls[0][1].onSuccess({ deleted: 3 })
  expect(onCleared).toHaveBeenCalledWith(3)
})

it.each([
  ['there are no completed tasks', 0, false, false],
  ['another operation is running', 2, true, false],
  ['the clear request is pending', 2, false, true],
])('is disabled when %s', async (_name, count, busy, isPending) => {
  const user = userEvent.setup()
  const { mutate } = arrange({ isPending })
  render(<ClearCompletedButton count={count} busy={busy} onCleared={vi.fn()} />)
  const button = screen.getByRole('button', {
    name: `Clear completed (${count})`,
  })
  expect(button).toBeDisabled()
  await user.click(button)
  expect(mutate).not.toHaveBeenCalled()
})

it('shows the mutation error in an alert', () => {
  arrange({ error: new Error('Could not clear.') })
  render(<ClearCompletedButton count={1} busy={false} onCleared={vi.fn()} />)
  expect(screen.getByTestId('alert')).toHaveTextContent('Could not clear.')
})

it('shows no alert without an error', () => {
  arrange()
  render(<ClearCompletedButton count={1} busy={false} onCleared={vi.fn()} />)
  expect(screen.queryByTestId('alert')).not.toBeInTheDocument()
})
