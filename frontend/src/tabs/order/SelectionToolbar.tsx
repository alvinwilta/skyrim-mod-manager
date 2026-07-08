import { useState } from 'react'
import type { OrderMod } from '../../api/types'

interface Props {
  count: number
  buckets: Record<string, string>
  mods: OrderMod[] // full ordered list, for group target positions
  disabled: boolean
  onLock: (locked: boolean) => void
  onMoveTo: (position: number) => void
  onClear: () => void
}

/**
 * Floating bulk-actions bar, fixed to the bottom of the viewport while any
 * rows are selected. Fixed positioning matters twice over: it never inserts
 * a blank strip into the page flow, and appearing/disappearing can't shift
 * the table mid drag (rows would slide out from under the pointer).
 */
export function SelectionToolbar({ count, buckets, mods, disabled, onLock, onMoveTo, onClear }: Props) {
  const [pos, setPos] = useState('')

  // "Move to group" → insert at the end of that bucket's last contiguous run
  const groupTargets = Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b)
    .map((b) => {
      let last = -1
      mods.forEach((m, i) => {
        if (m.bucket === b) last = i
      })
      return { bucket: b, position: last + 1 }
    })
    .filter((g) => g.position > 0)

  if (!count) return null

  return (
    <div className="seltoolbar toolbar" role="toolbar" aria-label="bulk actions">
      <b>{count} selected</b>
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
      <button className="btn ghost" disabled={disabled} onClick={() => onMoveTo(1)}>
        Top
      </button>
      <button className="btn ghost" disabled={disabled} onClick={() => onMoveTo(mods.length)}>
        Bottom
      </button>
      <select
        aria-label="move to group"
        disabled={disabled}
        value=""
        onChange={(e) => {
          const g = groupTargets.find((t) => String(t.bucket) === e.target.value)
          if (g) onMoveTo(g.position)
        }}
      >
        <option value="" disabled>
          Move to group…
        </option>
        {groupTargets.map((g) => (
          <option key={g.bucket} value={g.bucket}>
            {g.bucket} · {buckets[g.bucket] || '?'}
          </option>
        ))}
      </select>
      <button className="btn ghost" onClick={onClear}>
        Clear selection
      </button>
    </div>
  )
}
