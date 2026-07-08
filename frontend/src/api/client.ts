export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// Nearly every backend handler reports failure as {error: "..."} — sometimes
// with a 4xx status, sometimes inside a 200. Treat that field as authoritative.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data = await res.json().catch(() => null)
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: unknown }).error) {
    throw new ApiError(String((data as { error: unknown }).error), res.status)
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status)
  return data as T
}

export const get = <T>(path: string) => request<T>(path)

export const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
