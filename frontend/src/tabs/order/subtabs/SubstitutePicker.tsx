import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryRef } from '../../../api/types'

/**
 * Searchable combobox over the owned library: pick the mod that satisfies a
 * missing requirement. Closed state shows the current pick (or a placeholder);
 * open state is a filter input + the matching library rows. Purely local — the
 * parent owns the value and persists on change.
 */
export function SubstitutePicker({
  library,
  value,
  valueName,
  onPick,
  onClear,
}: {
  library: LibraryRef[]
  value: number | null
  valueName: string | null
  onPick: (modId: number) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The popup is position:fixed so it escapes the resizable panel's scroll
  // clipping. Recompute its coords from the button rect on open, and on any
  // scroll/resize while open (clamped into the viewport).
  useEffect(() => {
    if (!open) return
    const POP_W = 320
    const place = () => {
      const b = wrapRef.current?.getBoundingClientRect()
      if (!b) return
      const left = Math.max(8, Math.min(b.left, window.innerWidth - POP_W - 8))
      setPos({ top: b.bottom + 4, left, width: POP_W })
    }
    place()
    window.addEventListener('scroll', place, true) // capture: inner scroll containers too
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  // click-outside closes (button wrap OR the fixed popup)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else setQuery('')
  }, [open])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? library.filter((m) => m.mod_name.toLowerCase().includes(q) || String(m.mod_id).includes(q))
      : library
    return list.slice(0, 60) // cap the rendered rows; the search narrows the rest
  }, [library, query])

  return (
    <div className="subpick" ref={wrapRef}>
      <button
        type="button"
        className={`btn ghost subpick-btn${value ? ' has-val' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={value ? 'Change the substitute' : 'Pick an owned mod that satisfies this requirement'}
      >
        {value ? `✓ ${valueName ?? `mod ${value}`}` : 'Assign a substitute…'}
      </button>
      {value != null && (
        <button
          type="button"
          className="btn ghost subpick-clear"
          title="Clear this substitute"
          onClick={onClear}
        >
          ✕
        </button>
      )}
      {open && pos && (
        <div
          className="subpick-pop"
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
        >
          <input
            ref={inputRef}
            className="subpick-search"
            placeholder="Search your library…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="subpick-list">
            {matches.length === 0 && <li className="dim subpick-empty">No matching mod</li>}
            {matches.map((m) => (
              <li key={m.mod_id}>
                <button
                  type="button"
                  className={m.mod_id === value ? 'on' : ''}
                  onClick={() => {
                    onPick(m.mod_id)
                    setOpen(false)
                  }}
                >
                  {m.mod_name} <span className="dim">({m.mod_id})</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
