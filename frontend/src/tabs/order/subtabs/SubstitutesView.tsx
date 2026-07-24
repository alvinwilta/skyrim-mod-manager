import { useCallback, useEffect, useState } from 'react'
import { api } from '../../../api/endpoints'
import type { RequirementSub, RequirementSubs } from '../../../api/types'
import { DismissX, RestoreDismissed } from '../Dismiss'
import type { Dismissed } from '../hooks/useDismissed'
import { SubstitutePicker } from './SubstitutePicker'

/** pair-key for one requiring-mod → required-mod edge, matching
 *  RequirementsView.requirementKey so the two subtabs share dismissals. */
const pairKey = (requiringName: string, rid: number) => `${requiringName}|${rid}`

/**
 * "Substitutes" subtab: every missing required mod with a searchable picker to
 * say "an owned mod already covers this." Assigning a substitute marks the
 * requirement satisfied (server-side) so it leaves the Missing Requirements
 * subtab. The X dismisses the mod like the Missing Requirements X, and the two
 * are synced both ways:
 *   - X here (ridD, keyed by requires_mod_id) hides every line for that mod in
 *     Missing Requirements.
 *   - When every line for a mod has been dismissed in Missing Requirements
 *     (pairD), its row disappears here too.
 * Self-loads on mount (the subtab only renders when active).
 */
export function SubstitutesView({
  pairD,
  ridD,
  onCountChange,
}: {
  pairD: Dismissed
  ridD: Dismissed
  onCountChange?: (unresolvedVisible: number) => void
}) {
  const [data, setData] = useState<RequirementSubs | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.requirementSubs())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // a row is hidden if X'd here, or if every requiring line was dismissed over
  // in Missing Requirements (all mentions gone)
  const isHidden = useCallback(
    (it: RequirementSub) =>
      ridD.has(String(it.requires_mod_id)) ||
      (it.requiring.length > 0 &&
        it.requiring.every((r) => pairD.has(pairKey(r.mod_name, it.requires_mod_id)))),
    [ridD, pairD],
  )

  const items = (data?.items ?? []).filter((it) => !isHidden(it))
  const unresolved = items.filter((i) => i.sub_mod_id == null).length

  useEffect(() => {
    if (data) onCountChange?.(unresolved)
  }, [data, unresolved, onCountChange])

  // optimistic local update + re-sort (resolved sink to the bottom)
  const applyLocal = (rid: number, subId: number | null) => {
    setData((d) => {
      if (!d) return d
      const name = subId != null ? (d.library.find((l) => l.mod_id === subId)?.mod_name ?? null) : null
      const next = d.items.map((it) =>
        it.requires_mod_id === rid ? { ...it, sub_mod_id: subId, sub_mod_name: name } : it,
      )
      next.sort(
        (a, b) =>
          Number(a.sub_mod_id != null) - Number(b.sub_mod_id != null) ||
          a.requires_mod_name.toLowerCase().localeCompare(b.requires_mod_name.toLowerCase()),
      )
      return { ...d, items: next }
    })
  }

  const save = async (rid: number, subId: number | null) => {
    applyLocal(rid, subId)
    try {
      await api.setRequirementSub(rid, subId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void load()
    }
  }

  if (loading && !data) return <div className="dim">Loading…</div>

  return (
    <div className="reqtab">
      <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
        Missing Nexus dependencies. If an owned mod already covers one, assign it as a substitute — the engine treats
        it as satisfied and it leaves the Missing Requirements list. The × dismisses a mod (synced with Missing
        Requirements). Run “Sync requirements” to refresh.
      </div>
      {ridD.count > 0 && (
        <div className="dim" style={{ marginBottom: 8 }}>
          <RestoreDismissed d={ridD} />
        </div>
      )}
      {err && <div className="err">{err}</div>}

      {items.length === 0 ? (
        <div className="dim">No missing requirements. 🎉</div>
      ) : (
        <>
          <div className="dim" style={{ margin: '4px 0 8px' }}>
            {unresolved} unresolved · {items.length - unresolved} substituted
          </div>
          <ul className="reqlist">
            {items.map((it) => (
              <ReqRow
                key={it.requires_mod_id}
                it={it}
                library={data!.library}
                onPick={(sub) => void save(it.requires_mod_id, sub)}
                onClear={() => void save(it.requires_mod_id, null)}
                onDismiss={() => ridD.dismiss(String(it.requires_mod_id))}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function ReqRow({
  it,
  library,
  onPick,
  onClear,
  onDismiss,
}: {
  it: RequirementSub
  library: { mod_id: number; mod_name: string }[]
  onPick: (subId: number) => void
  onClear: () => void
  onDismiss: () => void
}) {
  return (
    <li className={`reqrow${it.sub_mod_id != null ? ' resolved' : ''}`}>
      <div className="reqrow-main">
        <div className="reqrow-missing">
          <a href={it.requires_url} target="_blank" rel="noreferrer" className="extlink">
            {it.requires_mod_name || `mod ${it.requires_mod_id}`} ↗
          </a>
          <span className="dim"> ({it.requires_mod_id})</span>
        </div>
        <div className="reqrow-by dim">required by {it.requiring.map((r) => r.mod_name).join(', ')}</div>
      </div>
      <div className="reqrow-actions">
        <SubstitutePicker
          library={library}
          value={it.sub_mod_id}
          valueName={it.sub_mod_name}
          onPick={onPick}
          onClear={onClear}
        />
        <DismissX onDismiss={onDismiss} />
      </div>
    </li>
  )
}
