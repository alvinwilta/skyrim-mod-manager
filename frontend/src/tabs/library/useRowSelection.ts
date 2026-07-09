import { useCallback, useRef, useState } from 'react'

/**
 * Checkbox multi-select with shift-click range, ported from the legacy
 * rangeSelect(): a shift-click applies the clicked box's new state to the
 * whole range between it and the previous click, in *visible* order.
 */
export function useRowSelection(visibleIds: number[]) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const lastIndex = useRef<number | null>(null)

  const toggle = useCallback(
    (id: number, index: number, shiftKey: boolean) => {
      // Snapshot the anchor now — the setSelected updater runs later (during
      // re-render), after lastIndex has already been overwritten below.
      const anchor = lastIndex.current
      lastIndex.current = index
      setSelected((prev) => {
        const next = new Set(prev)
        const check = !prev.has(id)
        if (shiftKey && anchor !== null) {
          // clamp: the anchor can be stale from before a filter shrank the
          // list — indexing past it would add `undefined` to the selection
          const [a, b] = [Math.min(index, anchor), Math.min(Math.max(index, anchor), visibleIds.length - 1)]
          for (let i = a; i <= b; i++) {
            if (check) next.add(visibleIds[i])
            else next.delete(visibleIds[i])
          }
        } else if (check) {
          next.add(id)
        } else {
          next.delete(id)
        }
        return next
      })
    },
    [visibleIds],
  )

  const setAll = useCallback(
    (check: boolean) => {
      setSelected(check ? new Set(visibleIds) : new Set())
      lastIndex.current = null
    },
    [visibleIds],
  )

  const clear = useCallback(() => {
    setSelected(new Set())
    lastIndex.current = null
  }, [])

  /** Replace the whole selection (e.g. default-checked groups on a new diff,
   *  plain row click). Optional anchor keeps shift-range working after. */
  const replace = useCallback((ids: Iterable<number>, anchorIndex: number | null = null) => {
    setSelected(new Set(ids))
    lastIndex.current = anchorIndex
  }, [])

  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  return { selected, toggle, setAll, clear, replace, allSelected }
}
