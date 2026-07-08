import { useState, type ReactNode } from 'react'

export interface SubtabDef {
  id: string
  label: string
  count?: number | string
}

/**
 * One independent subtab group (the legacy page has two — Ordering logs and
 * Analysis — each switching without touching the other). Resets to the first
 * tab on mount, which happens naturally on Order tab re-entry.
 */
export function Subtabs({ tabs, children }: { tabs: SubtabDef[]; children: (active: string) => ReactNode }) {
  const [active, setActive] = useState(tabs[0].id)

  return (
    <div className="subtabs" style={{ marginTop: 10 }}>
      <nav className="subtabnav">
        {tabs.map((t) => (
          <button key={t.id} className={t.id === active ? 'on' : ''} onClick={() => setActive(t.id)}>
            {t.label} {t.count ? <span className="dim">· {t.count}</span> : null}
          </button>
        ))}
      </nav>
      <div className="subtabpanel">{children(active)}</div>
    </div>
  )
}
