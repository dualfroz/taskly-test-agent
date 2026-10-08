import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from './http'

function stubFetch(response: Response | Error | DOMException) {
  const fetchMock =
    response instanceof Response
      ? vi.fn().mockResolvedValue(response)
      : vi.fn().mockRejectedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prefixes the path with /api and returns parsed JSON', async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify([{ id: 1 }]), { status: 200 }),
    )
    await expect(request('/todos')).resolves.toEqual([{ id: 1 }])
    expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('merges caller headers and keeps the other init options', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }))
    await request('/todos', {
      method: 'POST',
      headers: { 'X-Test': '1' },
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test': '1' },
    })
  })

  it('returns undefined for a 204 response', async () => {
    stubFetch(new Response(null, { status: 204 }))
    await expect(request('/todos/1', { method: 'DELETE' })).resolves.toBe(
      undefined,
    )
  })

  it('maps a 422 response to the validation message', async () => {
    stubFetch(new Response(JSON.stringify({ detail: [] }), { status: 422 }))
    await expect(request('/todos')).rejects.toThrow('Check the task details')
  })

  it('uses a string detail from an error response', async () => {
    stubFetch(
      new Response(JSON.stringify({ detail: 'Task not found.' }), {
        status: 404,
      }),
    )
    await expect(request('/todos/9')).rejects.toThrow('Task not found.')
  })

  it('falls back to a generic message for a non-string detail', async () => {
    stubFetch(new Response(JSON.stringify({ detail: [1] }), { status: 400 }))
    await expect(request('/todos')).rejects.toThrow(
      'The operation failed. Please try again.',
    )
  })

  it('falls back to a generic message for a non-JSON error body', async () => {
    stubFetch(new Response('<html>oops</html>', { status: 500 }))
    await expect(request('/todos')).rejects.toThrow(
      'The operation failed. Please try again.',
    )
  })

  it('reports a network failure as a connection problem', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    await expect(request('/todos')).rejects.toThrow(
      'Cannot connect to the server. Please try again.',
    )
  })

  it('rethrows the original error when the request was aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortError = new DOMException('Aborted', 'AbortError')
    stubFetch(abortError)
    await expect(request('/todos', { signal: controller.signal })).rejects.toBe(
      abortError,
    )
  })
})
