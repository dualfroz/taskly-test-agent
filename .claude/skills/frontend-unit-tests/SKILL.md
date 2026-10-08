---
name: frontend-unit-tests
description: Conventions and patterns for unit tests in the Taskly frontend - Vitest 4 with jsdom, React Testing Library, user-event, the design-system mock module, todoFixture, mocking lib/http and the todos API, React Query hooks with a fresh QueryClient, fake timers. Use when creating or updating frontend/src/**/*.test.ts(x).
paths: frontend/src/**
---

# Frontend unit tests (Vitest + React Testing Library)

## Setup you can rely on

- `frontend/vite.config.ts` runs Vitest in `jsdom` with `src/test/setup.ts`, which loads `@testing-library/jest-dom/vitest` matchers and calls `cleanup` after each test. Globals are not enabled: import `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` from `vitest` explicitly, like every existing test.
- Coverage (v8) includes `src/**/*.{ts,tsx}` and excludes `main.tsx`, `src/test/**`, test files, `src/design-system/**`, types, barrels (`index.ts`), constants, `features/todos/api/queryKeys.ts` and `lib/queryClient.ts`.
- Formatting is Prettier with `semi: false`, `singleQuote: true`, `trailingComma: 'all'`. Run the `format` command from the `run-and-verify-tests` skill on every file you touch; CI runs `format:check`.
- `tsc --noEmit` covers test files too. Type mocks properly; `as unknown as ReturnType<typeof useX>` is the accepted pattern for partial hook results.

## Files and naming

- Colocate the test next to the source: `TodoItem.tsx` -> `TodoItem.test.tsx`, `todos.ts` -> `todos.test.ts`. Use `.tsx` whenever the file contains JSX.
- Extend an existing test file instead of creating a second one for the same module.
- A file with one scenario uses top-level `it(...)`; a file with several uses one `describe('<Unit>', ...)` block (see `TodoForm.test.tsx`, `utils/todos.test.ts`).
- Test names describe behaviour in plain English: `'rejects a whitespace-only title without submitting'`, `'shows loading feedback before showing an empty list'`.
- Shared fixtures and helpers live in `frontend/src/test/`. Reuse `todoFixture` (`src/test/todoFixture.ts`) and derive variants by spreading: `{ ...todoFixture, completed: true, due_date: '2026-10-15' }`. Add a new helper there only when two or more test files need it.
- Some UI strings contain typographic characters: the ellipsis U+2026 in `Loading your tasks` and `Saving`, curly quotes U+201C and U+201D around the title in the delete dialog, and an em dash U+2014 in the `Taskly - home` link label. Copy such strings from the source file instead of retyping them.

## Mocking rules of this repo

**Design system.** Components import from `design-system`. Replace it with the Vitest mock module, always through an async factory because `vi.mock` is hoisted:

```tsx
vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
```

The mocks render plain native elements and are `vi.fn` components, so you can query the DOM and assert design props:

- `Button`, `IconButton` -> `<button>`; `Heading` -> `h1..h6` by `level`; `Text` -> `<p>` or the `as` element; `Badge` -> `<span>`; `Card` -> `<div>`.
- `Alert` -> `<div data-testid="alert">`. This is the only test id in the repo; prefer roles everywhere else.
- `Input`, `Select` -> `<label>{label}<input|textarea|select/>{error}</label>`, so `getByLabelText('Priority')` works and errors render as text.
- `Checkbox` -> a labelled checkbox; `Drawer` -> `role="dialog"` named by `title` with a `Close` button, rendered only when `isOpen`.
- Assert design props through the mock calls and reset them per test:

```tsx
beforeEach(() => vi.clearAllMocks())

expect(vi.mocked(Alert).mock.calls[0][0]).toEqual(
  expect.objectContaining({ variant: 'success' }),
)
```

If a component uses a design-system export that `mocks.tsx` does not provide yet, add a mock with the same shape (native element, `vi.fn`, `nativeProps`). Never change existing mocks.

**Child components** of the unit under test are replaced with tiny stand-ins when the test is about the parent (see `TodosPage.test.tsx`, `TodoList.test.tsx`):

```tsx
vi.mock('./TodoItem', () => ({ TodoItem: () => <li>Task</li> }))
```

**Hooks** used by a component are mocked per test with typed partial results:

```tsx
vi.mock('../hooks/useDeleteTodoMutation', () => ({
  useDeleteTodoMutation: vi.fn(),
}))

vi.mocked(useDeleteTodoMutation).mockReturnValue({
  isPending: false,
  error: null,
  mutateAsync,
} as unknown as ReturnType<typeof useDeleteTodoMutation>)
```

**API module** (`features/todos/api/todos.ts`) tests mock the HTTP layer, never `fetch`:

```ts
vi.mock('../../../lib/http', () => ({ request: vi.fn() }))
vi.mocked(request).mockResolvedValue(todoFixture)
expect(request).toHaveBeenCalledWith('/todos/7', { method: 'PATCH', body: JSON.stringify({ ... }) })
```

**HTTP client** (`lib/http.ts`) is the only place where `fetch` is stubbed. Use real `Response` objects and restore the global:

```ts
afterEach(() => vi.unstubAllGlobals())

it('maps a 422 response to the validation message', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: [] }), { status: 422 })))
  await expect(request('/todos')).rejects.toThrow('Check the task details')
})
```

Cover: JSON success, `204` returning `undefined`, `422`, a string `detail`, a non-JSON error body, a network failure (`mockRejectedValue(new TypeError('Failed to fetch'))`) and an aborted request rethrowing the original error. Assert the URL prefix `/api` and the merged `Content-Type` header.

## Patterns

**Components**: render with props, interact with `userEvent`, assert what the user sees and which callbacks fired.

```tsx
it('blocks deletion while busy', async () => {
  const user = userEvent.setup()
  const onDelete = vi.fn()
  render(<TodoItem todo={todoFixture} busy onToggle={vi.fn()} onEdit={vi.fn()} onDelete={onDelete} />)
  const button = screen.getByRole('button', { name: `Delete: ${todoFixture.title}` })
  expect(button).toBeDisabled()
  await user.click(button)
  expect(onDelete).not.toHaveBeenCalled()
})
```

Query priority: `getByRole` with `name` > `getByLabelText` > `getByText` > `getByTestId('alert')`. Use `queryBy*` only for absence, `findBy*` or `waitFor` for async appearance. Always create `const user = userEvent.setup()` before rendering.

**React Query hooks** (`useTodosQuery`, `useCreateTodoMutation`, `useUpdateTodoMutation`, `useDeleteTodoMutation`, `useTodosBusy`): use a fresh client per test with retries off, mock `todosApi`, and check both the API call and the cache update.

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'

vi.mock('../api/todos', () => ({
  todosApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
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

it('puts a created task first and drops a stale copy', async () => {
  const { client, wrapper } = setup()
  const saved = { ...todoFixture, id: 8 }
  client.setQueryData(todoKeys.list, [todoFixture, saved])
  vi.mocked(todosApi.create).mockResolvedValue(saved)
  const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
  await act(() => result.current.mutateAsync(saved))
  expect(client.getQueryData(todoKeys.list)).toEqual([saved, todoFixture])
})
```

Also cover the empty-cache paths (`current` undefined) and, for queries, that the abort `signal` is forwarded (`await waitFor(() => expect(result.current.isSuccess).toBe(true))`). For `useTodosBusy`, start a mutation with `todoKeys.*` that never resolves and assert `true`, then resolve it and assert `false`. Call `client.clear()` in `afterEach` if the client is module-level.

**Plain hooks** (`useTodoFilters`, `useNotice`): `renderHook`, change state inside `act`, assert the returned values.

**Time**: anything using `setTimeout` or `new Date()` runs under fake timers, restored after each test:

```ts
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('clears the notice after four seconds', () => {
  const { result } = renderHook(() => useNotice())
  act(() => result.current.notify('Saved.'))
  act(() => vi.advanceTimersByTime(3999))
  expect(result.current.message).toBe('Saved.')
  act(() => vi.advanceTimersByTime(1))
  expect(result.current.message).toBe('')
})
```

For date logic (`isOverdue`, `formatDate`) set the clock with the local-time constructor, `vi.setSystemTime(new Date(2026, 9, 10, 12))`, so the result does not depend on the machine's time zone. Combine fake timers with user-event through `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`.

**Pure utilities** (`utils/todos.ts`): table-driven with `it.each` when cases share a shape; assert immutability where the function promises it (see the `selectTodos` sort test).

## Anti-patterns (reject them in your own output)

- Snapshot tests or asserting large HTML strings.
- Asserting implementation details: internal state, hook call counts unrelated to behaviour, CSS class names, styled-components output.
- Real network or a real backend; stubbing `fetch` anywhere except `lib/http` tests.
- Real timers with `setTimeout` waits, `sleep`, or tests that depend on today's date or the local time zone.
- `getByTestId` for elements that have a role or label.
- Mocking the module under test, or mocking so much that the test only checks the mock.
- Tests without a meaningful assertion, or assertions that would still pass if the code under test returned a hard-coded value.
- `it.skip`, `it.only`, `it.todo`, or loosening an existing expectation to get green.
