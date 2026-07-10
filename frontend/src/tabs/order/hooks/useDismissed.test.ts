import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDismissed } from './useDismissed'

// This jsdom build ships no localStorage — back the global with a Map.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

describe('useDismissed', () => {
  beforeEach(() => localStorage.clear())

  it('dismisses and clears', () => {
    const { result } = renderHook(() => useDismissed('test'))
    expect(result.current.has('a')).toBe(false)
    act(() => result.current.dismiss('a'))
    expect(result.current.has('a')).toBe(true)
    expect(result.current.count).toBe(1)
    act(() => result.current.clear())
    expect(result.current.has('a')).toBe(false)
    expect(result.current.count).toBe(0)
  })

  it('persists across mounts via localStorage', () => {
    const first = renderHook(() => useDismissed('test'))
    act(() => first.result.current.dismiss('x'))
    first.unmount()
    const second = renderHook(() => useDismissed('test'))
    expect(second.result.current.has('x')).toBe(true)
  })

  it('clear removes the storage key', () => {
    const { result } = renderHook(() => useDismissed('test'))
    act(() => result.current.dismiss('x'))
    expect(localStorage.getItem('modman.dismissed.test')).not.toBeNull()
    act(() => result.current.clear())
    expect(localStorage.getItem('modman.dismissed.test')).toBeNull()
  })

  it('sections are independent', () => {
    const a = renderHook(() => useDismissed('a'))
    const b = renderHook(() => useDismissed('b'))
    act(() => a.result.current.dismiss('k'))
    expect(b.result.current.has('k')).toBe(false)
  })
})
