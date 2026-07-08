import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePoller } from './usePoller'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const flush = () => act(async () => {})

describe('usePoller', () => {
  it('ticks immediately, then on each interval', async () => {
    const tick = vi.fn(async () => true)
    renderHook(() => usePoller(tick, 1000, true))
    await flush()
    expect(tick).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('suppresses overlapping ticks while one is in flight', async () => {
    let release!: () => void
    const tick = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        }),
    )
    renderHook(() => usePoller(tick, 1000, true))
    await flush()
    expect(tick).toHaveBeenCalledTimes(1)

    // Two intervals pass while the first tick is still pending — no new calls.
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(tick).toHaveBeenCalledTimes(1)

    await act(async () => release())
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('stops when tick returns false', async () => {
    const tick = vi.fn(async () => false)
    renderHook(() => usePoller(tick, 1000, true))
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('does not tick when disabled, and stops on unmount', async () => {
    const tick = vi.fn(async () => true)
    const { rerender, unmount } = renderHook(({ on }) => usePoller(tick, 1000, on), {
      initialProps: { on: false },
    })
    await flush()
    expect(tick).not.toHaveBeenCalled()

    rerender({ on: true })
    await flush()
    expect(tick).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('keeps polling after a tick throws', async () => {
    const tick = vi.fn(async () => {
      if (tick.mock.calls.length === 1) throw new Error('boom')
      return true
    })
    renderHook(() => usePoller(tick, 1000, true))
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
