import { useState } from 'react'
import { api } from '../../api/endpoints'
import type { OrderMod, Separator } from '../../api/types'

const UNASSIGNED = -999 // pseudo-band for mods with no separator_id yet

// Read-oriented grouped view of the order: mods bucketed under their separator
// band, bands in band order (id asc), collapsible. Ordering itself still lives
// in the flat drag list — this is the cosmetic grouping layer (Phase 2). Within
// a band, mods keep their rank order (the array order handed in).
export function BandView({ mods, separators }: { mods: OrderMod[]; separators: Separator[] }) {
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(separators.filter((s) => s.collapsed).map((s) => [s.id, true])),
  )
  const byId = new Map(separators.map((s) => [s.id, s]))

  const groups = new Map<number, OrderMod[]>()
  for (const m of mods) {
    const k = m.separator_id ?? UNASSIGNED
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(m)
  }
  const keys = [...groups.keys()].sort((a, b) => (a === UNASSIGNED ? Infinity : a) - (b === UNASSIGNED ? Infinity : b))

  const toggle = (id: number) => {
    const next = !collapsed[id]
    setCollapsed((c) => ({ ...c, [id]: next }))
    void api.collapseSeparator(id, next).catch(() => {})
  }

  return (
    <div className="bandview">
      {keys.map((k) => {
        const sep = k === UNASSIGNED ? null : byId.get(k)
        const list = groups.get(k)!
        const isCol = k !== UNASSIGNED && !!collapsed[k]
        const kind = sep?.special_kind
        return (
          <div key={k} className="band">
            <button
              className={`band-h${kind ? ` band-${kind}` : ''}`}
              onClick={() => k !== UNASSIGNED && toggle(k)}
              disabled={k === UNASSIGNED}
            >
              <span className="band-caret">{k === UNASSIGNED ? '' : isCol ? '▸' : '▾'}</span>
              <span className="band-name">{sep ? sep.name : 'Unassigned'}</span>
              <span className="band-count">{list.length}</span>
            </button>
            {!isCol &&
              list.map((m) => (
                <div key={m.mod_id} className="band-row">
                  <span className="band-mod">{m.mod_name}</span>
                  {m.mo2_state === 'removed' ? (
                    <span className="badge" style={{ background: '#3a1214', color: 'var(--red)' }}>
                      not in MO2
                    </span>
                  ) : m.mo2_state === 'disabled' ? (
                    <span className="badge" style={{ background: '#3a2b12', color: 'var(--amber)' }}>
                      MO2 off
                    </span>
                  ) : null}
                  {m.source === 'mo2' && (
                    <span className="badge" style={{ background: '#1e2b3a', color: 'var(--blue)' }}>
                      MO2 only
                    </span>
                  )}
                  {m.locked && <span className="band-lock" title="pinned">🔒</span>}
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}
