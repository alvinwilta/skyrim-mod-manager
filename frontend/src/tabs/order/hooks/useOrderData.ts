import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../../api/endpoints'
import { ApiError } from '../../../api/client'
import type { OrderMod } from '../../../api/types'

export const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

/**
 * Install-order data cache. Fetched once (plus explicit reload()); category
 * and group filters re-derive from the cache without refetching (legacy
 * orderMods behavior).
 */
export function useOrderData() {
  const [mods, setMods] = useState<OrderMod[]>([])
  const [buckets, setBuckets] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<string[]>([])
  const [refining, setRefining] = useState(false)
  const [committed, setCommitted] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.installOrder(), api.sortState()])
      setMods(d.mods)
      setBuckets(d.buckets)
      setNotes(d.notes)
      setRefining(s.running)
      setCommitted(d.committed)
      setHidden(d.hidden)
      setError('')
      return d
    } catch (e) {
      setError(errText(e))
      return null
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const names = useMemo(() => new Map(mods.map((m) => [m.mod_id, m.mod_name])), [mods])
  const categories = useMemo(() => [...new Set(mods.map((m) => m.category).filter(Boolean))].sort() as string[], [mods])

  // Optimistic client-side mirror of order_store.move: splice the moving block
  // (kept in its current relative order) out and back in at `position` (1-based,
  // over the FULL pre-move list — same semantics resolveMove already computes).
  // Without this, the row's array index doesn't change until the reload
  // round-trip completes, so dnd-kit's transform resets to 0 the instant the
  // drop lands — visually snapping the row back to its old spot before the
  // reload snaps it again to the real one.
  //
  // `separatorId` (a cross-band drag) is stamped onto the moved mods HERE too,
  // so the very next render already groups them into the destination band. Skip
  // it and the row would splice to the new index while still carrying its old
  // band — the exact stale-band frame that used to flash a broken/duplicate
  // divider before the server reload corrected it.
  const reorderLocal = useCallback((ids: number[], position: number, separatorId?: number | null) => {
    setMods((prev) => {
      const movingSet = new Set(ids)
      const moving = prev
        .filter((m) => movingSet.has(m.mod_id))
        .map((m) => (separatorId != null ? { ...m, separator_id: separatorId } : m))
      const rest = prev.filter((m) => !movingSet.has(m.mod_id))
      const pos = Math.max(0, Math.min(rest.length, position - 1))
      const next = rest.slice()
      next.splice(pos, 0, ...moving)
      return next
    })
  }, [])

  return {
    mods,
    buckets,
    notes,
    names,
    categories,
    refining,
    setRefining,
    committed,
    setCommitted,
    hidden,
    setHidden,
    error,
    setError,
    reload,
    reorderLocal,
  }
}

export function matchesFilter(m: OrderMod, cat: string, grp: string, q = ''): boolean {
  if (cat && m.category !== cat) return false
  if (grp === 'none' && m.bucket != null) return false
  if (grp && grp !== 'none' && String(m.bucket) !== grp) return false
  if (q && !m.mod_name.toLowerCase().includes(q.toLowerCase()) && String(m.mod_id) !== q) return false
  return true
}
