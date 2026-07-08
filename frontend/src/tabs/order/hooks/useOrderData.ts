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
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.installOrder(), api.sortState()])
      setMods(d.mods)
      setBuckets(d.buckets)
      setNotes(d.notes)
      setRefining(s.running)
      setCommitted(d.committed)
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

  return { mods, buckets, notes, names, categories, refining, setRefining, committed, setCommitted, error, setError, reload }
}

export function matchesFilter(m: OrderMod, cat: string, grp: string): boolean {
  if (cat && m.category !== cat) return false
  if (grp === 'none' && m.bucket != null) return false
  if (grp && grp !== 'none' && String(m.bucket) !== grp) return false
  return true
}
