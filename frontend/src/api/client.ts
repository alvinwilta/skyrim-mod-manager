export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// Backend handlers report failure as {error: "..."} with a 4xx/5xx status.
// An `error` field inside a 200 is DATA, not failure: the job-state endpoints
// (/api/sort-state, /api/order/commit-state, ...) echo the last run's error
// while running=false — throwing on it would fail every poll (and any
// Promise.all it's part of) until the next job clears it.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (data && typeof data === 'object' && 'error' in data && (data as { error?: unknown }).error) {
      throw new ApiError(String((data as { error: unknown }).error), res.status)
    }
    throw new ApiError(`HTTP ${res.status}`, res.status)
  }
  return data as T
}

export const get = <T>(path: string) => request<T>(path)

export const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
