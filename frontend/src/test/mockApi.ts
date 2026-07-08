import { vi } from 'vitest'

type Responder = unknown | ((body: unknown, url: URL) => unknown)

export interface RecordedCall {
  method: string
  path: string
  body: unknown
}

/**
 * Stub global.fetch with a route table keyed "METHOD /path" (path matched
 * without query string). Value = static JSON or (body, url) => JSON. Throw a
 * Response-shaped error object {status, error} to simulate failures:
 *   mockApi({'GET /api/mods': [...], 'POST /api/delete': {deleted: 2}})
 * Returns recorded calls for assertions. Unmatched routes reject loudly.
 */
export function mockApi(routes: Record<string, Responder>) {
  const calls: RecordedCall[] = []

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url.pathname}`
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: url.pathname, body })

    if (!(key in routes)) throw new Error(`mockApi: unmatched route ${key}`)
    const responder = routes[key]
    const result = typeof responder === 'function' ? (responder as (b: unknown, u: URL) => unknown)(body, url) : responder
    const status =
      result && typeof result === 'object' && '__status' in (result as object)
        ? ((result as { __status: number }).__status)
        : 200
    return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } })
  })

  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}
