import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSSE } from './useSSE'
import { FakeEventSource } from '../test/FakeEventSource'

let uninstall: () => void

beforeEach(() => {
  vi.useFakeTimers()
  uninstall = FakeEventSource.install()
})

afterEach(() => {
  uninstall()
  vi.useRealTimers()
})

describe('useSSE', () => {
  it('parses frames and reports connected state', () => {
    const onMessage = vi.fn()
    const { result } = renderHook(() => useSSE('/api/events', onMessage))

    act(() => FakeEventSource.last.emitOpen())
    expect(result.current.connected).toBe(true)

    act(() => FakeEventSource.last.emit({ dl: { running: true }, sort: {} }))
    expect(onMessage).toHaveBeenCalledWith({ dl: { running: true }, sort: {} })
  })

  it('ignores malformed frames', () => {
    const onMessage = vi.fn()
    renderHook(() => useSSE('/api/events', onMessage))
    act(() => FakeEventSource.last.onmessage?.({ data: 'not json' }))
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('reconnects 2s after an error', () => {
    renderHook(() => useSSE('/api/events', vi.fn()))
    const first = FakeEventSource.last

    act(() => first.emitError())
    expect(first.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => vi.advanceTimersByTime(2000))
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.last).not.toBe(first)
  })

  it('cleans up on unmount: closes source, cancels pending reconnect', () => {
    const { unmount } = renderHook(() => useSSE('/api/events', vi.fn()))
    const es = FakeEventSource.last

    act(() => es.emitError())
    unmount()
    act(() => vi.advanceTimersByTime(10000))
    expect(FakeEventSource.instances).toHaveLength(1) // no reconnect after unmount
    expect(es.closed).toBe(true)
  })
})
