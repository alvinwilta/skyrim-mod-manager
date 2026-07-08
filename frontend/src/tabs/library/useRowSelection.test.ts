import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRowSelection } from './useRowSelection'

const ids = [10, 20, 30, 40, 50]

describe('useRowSelection', () => {
  it('toggles single ids', () => {
    const { result } = renderHook(() => useRowSelection(ids))
    act(() => result.current.toggle(20, 1, false))
    expect([...result.current.selected]).toEqual([20])
    act(() => result.current.toggle(20, 1, false))
    expect(result.current.selected.size).toBe(0)
  })

  it('shift-click selects the whole range in visible order', () => {
    const { result } = renderHook(() => useRowSelection(ids))
    act(() => result.current.toggle(20, 1, false))
    act(() => result.current.toggle(50, 4, true))
    expect([...result.current.selected].sort((a, b) => a - b)).toEqual([20, 30, 40, 50])
  })

  it('shift-click on a selected box deselects the range', () => {
    const { result } = renderHook(() => useRowSelection(ids))
    act(() => result.current.setAll(true))
    act(() => result.current.toggle(10, 0, false)) // uncheck first, sets anchor
    act(() => result.current.toggle(30, 2, true)) // shift-uncheck through index 2
    expect([...result.current.selected].sort((a, b) => a - b)).toEqual([40, 50])
  })

  it('select-all / clear', () => {
    const { result } = renderHook(() => useRowSelection(ids))
    act(() => result.current.setAll(true))
    expect(result.current.allSelected).toBe(true)
    act(() => result.current.clear())
    expect(result.current.selected.size).toBe(0)
    expect(result.current.allSelected).toBe(false)
  })

  it('range uses current visible order after a filter change', () => {
    const { result, rerender } = renderHook(({ v }) => useRowSelection(v), {
      initialProps: { v: ids },
    })
    act(() => result.current.toggle(10, 0, false))
    rerender({ v: [10, 30, 50] }) // filtered list
    act(() => result.current.toggle(50, 2, true))
    expect([...result.current.selected].sort((a, b) => a - b)).toEqual([10, 30, 50])
  })
})
