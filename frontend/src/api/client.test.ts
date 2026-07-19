import { afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { get, post } from './client'
import { mockApi } from '../test/mockApi'

afterEach(() => vi.unstubAllGlobals())

describe('api client', () => {
  it('returns parsed JSON on success', async () => {
    mockApi({ 'GET /api/mods': [{ file_id: 1 }] })
    await expect(get('/api/mods')).resolves.toEqual([{ file_id: 1 }])
  })

  it('returns {error} field as data on HTTP 200 (job-state polls)', async () => {
    mockApi({ 'GET /api/sort-state': { running: false, phase: 'Error', error: 'claude timed out' } })
    await expect(get('/api/sort-state')).resolves.toEqual({
      running: false,
      phase: 'Error',
      error: 'claude timed out',
    })
  })

  it('throws ApiError with {error} body and 4xx status', async () => {
    mockApi({ 'POST /api/delete': { __status: 400, error: 'no file_ids' } })
    await expect(post('/api/delete', {})).rejects.toMatchObject({ message: 'no file_ids', status: 400 })
  })

  it('throws HTTP error when non-ok without {error} body', async () => {
    mockApi({ 'GET /api/state': { __status: 500 } })
    await expect(get('/api/state')).rejects.toMatchObject({ message: 'HTTP 500', status: 500 })
  })

  it('posts JSON body with content-type header', async () => {
    const { calls } = mockApi({ 'POST /api/order/lock': { mod_id: 5, locked: true } })
    await post('/api/order/lock', { mod_id: 5, locked: true })
    expect(calls[0]).toEqual({ method: 'POST', path: '/api/order/lock', body: { mod_id: 5, locked: true } })
  })
})
