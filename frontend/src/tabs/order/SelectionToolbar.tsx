import { useState } from 'react'
import type { OrderMod, Separator } from '../../api/types'

interface Props {
  count: number
  /** every band (grouping taxonomy); mod_count marks which exist in this order */
  separators: Separator[]
  /** bucket id -> name for the group axis (STEP buckets, e.g. 1 · Extenders) */
  buckets: Record<string, string>
  mods: OrderMod[] // full ordered list, for group target positions
  selected: ReadonlySet<number> // the mods being moved, excluded from position math
  disabled: boolean
  onLock: (locked: boolean) => void
  onMoveTo: (position: number) => void
  onMoveToSeparator: (separatorId: number) => void
  onDelete: () => void
  onClear: () => void
}

/**
 * Floating bulk-actions bar, fixed to the bottom of the viewport while any
 * rows are selected. Fixed positioning matters twice over: it never inserts
 * a blank strip into the page flow, and appearing/disappearing can't shift
 * the table mid drag (rows would slide out from under the pointer).
 */
export function SelectionToolbar({
  count,
  separators,
  buckets,
  mods,
  selected,
  disabled,
  onLock,
  onMoveTo,
  onMoveToSeparator,
  onDelete,
  onClear,
}: Props) {
  const [pos, setPos] = useState('')

  // Separator targets = every band except the structural section titles
  // (header/root), which mods never live directly under. Split into the bands
  // actually present in this load order and the rest, so the user sees what
  // already exists first.
  const sepTargets = separators.filter((s) => s.special_kind !== 'header' && s.special_kind !== 'root')
  const sepInOrder = sepTargets.filter((s) => s.mod_count > 0)
  const sepOthers = sepTargets.filter((s) => s.mod_count === 0)

  // Group (bucket) targets → insert right after that bucket's last mod. The
  // backend removes the moving mods first and then inserts at position-1, so the
  // target must be computed on the list WITHOUT the selection.
  const remaining = mods.filter((m) => !selected.has(m.mod_id))
  const groupTargets = Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b)
    .map((b) => {
      let last = -1
      remaining.forEach((m, i) => {
        if (m.bucket === b) last = i
      })
      return { bucket: b, position: last + 2 } // 1-based slot after `last`
    })
    .filter((g) => g.position > 1)

  if (!count) return null

  return (
    <div className="seltoolbar toolbar" role="toolbar" aria-label="bulk actions">
      <b>{count} selected</b>
      <button className="btn ghost" onClick={onClear}>
        Clear selection
      </button>
      <button className="btn ghost" disabled={disabled} onClick={() => onLock(true)}>
        Lock
      </button>
      <button className="btn ghost" disabled={disabled} onClick={() => onLock(false)}>
        Unlock
      </button>
      <input
        type="number"
        className="posedit"
        placeholder="position…"
        min={1}
        aria-label="bulk move to position"
        value={pos}
        onChange={(e) => setPos(e.target.value)}
        onKeyDown={(e) => {
          const p = parseInt(pos, 10)
          if (e.key === 'Enter' && p >= 1) {
            onMoveTo(p)
            setPos('')
          }
        }}
      />
      <button
        className="btn ghost"
        disabled={disabled || !(parseInt(pos, 10) >= 1)}
        onClick={() => {
          onMoveTo(parseInt(pos, 10))
          setPos('')
        }}
      >
        Move
      </button>
      {/* separator (band) axis */}
      <select
        className="grpselect"
        aria-label="change separator"
        disabled={disabled}
        value=""
        onChange={(e) => {
          const id = parseInt(e.target.value, 10)
          if (!Number.isNaN(id)) onMoveToSeparator(id)
        }}
      >
        <option value="" disabled>
          Change separator…
        </option>
        {sepInOrder.length > 0 && (
          <optgroup label="In this order">
            {sepInOrder.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} · {s.name} ({s.mod_count})
              </option>
            ))}
          </optgroup>
        )}
        {sepOthers.length > 0 && (
          <optgroup label="Other separators (empty)">
            {sepOthers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} · {s.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {/* group (bucket) axis */}
      <select
        className="grpselect"
        aria-label="change group"
        disabled={disabled}
        value=""
        onChange={(e) => {
          const g = groupTargets.find((t) => String(t.bucket) === e.target.value)
          if (g) onMoveTo(g.position)
        }}
      >
        <option value="" disabled>
          Change group…
        </option>
        {groupTargets.map((g) => (
          <option key={g.bucket} value={g.bucket}>
            {g.bucket} · {buckets[g.bucket] || '?'}
          </option>
        ))}
      </select>
      <button
        className="btn ghost"
        disabled={disabled}
        style={{ color: 'var(--red)', borderColor: '#4a2226' }}
        onClick={onDelete}
      >
        Delete ({count})
      </button>
    </div>
  )
}
