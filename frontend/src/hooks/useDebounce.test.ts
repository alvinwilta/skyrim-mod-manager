import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDebounce } from './useDebounce'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useDebounce', () => {
  it('only surfaces the last value after the quiet period', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 250), {
      initialProps: { v: 'a' },
    })
    expect(result.current).toBe('a')

    rerender({ v: 'ab' })
    act(() => vi.advanceTimersByTime(100))
    rerender({ v: 'abc' })
    act(() => vi.advanceTimersByTime(249))
    expect(result.current).toBe('a') // still quiet-period

    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe('abc')
  })
})
