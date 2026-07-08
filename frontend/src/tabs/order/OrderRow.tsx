import { memo, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { OrderMod } from '../../api/types'
import { FlagBadge } from './FlagBadges'
import { GroupBadge } from './GroupBadge'
import { flagCategory, type Highlights } from './lib/highlights'

interface Props {
  mod: OrderMod
  pos: number
  names: ReadonlyMap<number, string>
  buckets: Record<string, string>
  hl: Highlights
  selected: boolean
  wrongExpected: number | null | undefined // bucket id when drift-flagged
  mo2Wrong: boolean // true when this mod is out of order vs MO2's install order
  justChanged: boolean
  disabled: boolean // refining: no drag, no lock, no move
  onRowClick: (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void
  onToggleLock: () => void
  onMoveTo: (position: number) => void
}

function PosCell({ pos, disabled, onMoveTo }: { pos: number; disabled: boolean; onMoveTo: (p: number) => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(String(pos))

  if (disabled) return <span className="dim">{pos}</span>
  if (!editing)
    return (
      <a
        href="#"
        className="posnum"
        title="click to type an exact position"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setVal(String(pos))
          setEditing(true)
        }}
      >
        {pos}
      </a>
    )
  return (
    <input
      type="number"
      className="posedit"
      autoFocus
      value={val}
      min={1}
      aria-label="move to position"
      onChange={(e) => setVal(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const p = parseInt(val, 10)
          setEditing(false)
          if (p >= 1 && p !== pos) onMoveTo(p)
        } else if (e.key === 'Escape') {
          setEditing(false)
        }
      }}
      onBlur={() => setEditing(false)}
    />
  )
}

/**
 * Cells 2..6 (everything past the drag handle), split out and memoized. During
 * a drag, dnd-kit re-renders every sortable row on each pointer move just to
 * refresh transforms — but none of THESE props change mid-drag (the parent
 * doesn't re-render, so the inline handlers keep their identity), so this whole
 * subtree — the flag filtering, badges and links — is skipped. Only the cheap
 * <tr> transform style recomputes per frame. Kept out of the memo boundary:
 * dnd-kit's attributes/listeners, which get fresh identities each render.
 */
const RowCells = memo(function RowCells({
  mod,
  pos,
  names,
  buckets,
  hl,
  wrong,
  wrongExpected,
  mo2Wrong,
  disabled,
  onToggleLock,
  onMoveTo,
}: {
  mod: OrderMod
  pos: number
  names: ReadonlyMap<number, string>
  buckets: Record<string, string>
  hl: Highlights
  wrong: boolean
  wrongExpected: number | null | undefined
  mo2Wrong: boolean
  disabled: boolean
  onToggleLock: () => void
  onMoveTo: (position: number) => void
}) {
  const shownFlags = (mod.flags || []).filter((f) => {
    const cat = flagCategory(f)
    return cat === null || hl[cat]
  })
  return (
    <>
      <td className="num" style={{ width: 70, whiteSpace: 'nowrap' }}>
        <button
          className={`lockbtn${mod.locked ? ' on' : ''}`}
          disabled={disabled}
          title={mod.locked ? 'pinned — sorts will not move this; click to unpin' : 'pin at this position'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleLock()
          }}
        >
          {mod.locked ? '🔒' : '🔓'}
        </button>
        <PosCell pos={pos} disabled={disabled} onMoveTo={onMoveTo} />
      </td>
      <td>
        {mod.installed && <span className="badge b-new">installed </span>}
        {mod.file_type === 'bsa' && (
          <span
            className="badge b-bsa"
            title="archive contains only packed BSA/BA2 + plugin files — no loose Data assets, position barely matters for real conflicts"
          >
            BSA-only{' '}
          </span>
        )}
        {mod.mod_name}{' '}
        {shownFlags.map((f) => (
          <FlagBadge key={f} flag={f} names={names} buckets={buckets} />
        ))}
        {wrong && (
          <FlagBadge
            flag={wrongExpected != null ? `WRONG SPOT:${wrongExpected}` : 'WRONG SPOT'}
            names={names}
            buckets={buckets}
          />
        )}
        {mo2Wrong && !wrong && (
          <span className="badge" style={{ background: '#3a1214', color: 'var(--red)' }} title="out of order vs MO2's real install order">
            MO2 ORDER{' '}
          </span>
        )}
      </td>
      <td className="num">
        <a href={mod.mod_url} target="_blank" rel="noreferrer" className="dim">
          {mod.mod_id}
        </a>
      </td>
      <td className="hide-sm dim">{mod.category || ''}</td>
      <td className="num">
        <GroupBadge bucket={mod.bucket} buckets={buckets} />
      </td>
    </>
  )
})

export function OrderRow({
  mod,
  pos,
  names,
  buckets,
  hl,
  selected,
  wrongExpected,
  mo2Wrong,
  justChanged,
  disabled,
  onRowClick,
  onToggleLock,
  onMoveTo,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mod.mod_id,
    disabled,
  })
  // whole-row drag: after a drop, the browser still fires a click on the row —
  // remember the drag so that click doesn't toggle selection
  const wasDragged = useRef(false)
  if (isDragging) wasDragged.current = true

  const wrong = wrongExpected !== undefined
  const moved = hl.moved && ((mod.flags?.some((f) => f.startsWith('MOVED')) ?? false) || justChanged)
  const rowCls = ['ordrow', wrong || mo2Wrong ? 'r-wrong' : moved ? 'r-upd' : mod.locked ? 'r-locked' : '', selected ? 'r-sel' : '']
    .filter(Boolean)
    .join(' ')
  const hint = wrong
    ? `now in "${buckets[String(mod.bucket)] || 'unsorted'}", but Sort/Refine expected "${buckets[String(wrongExpected)] || 'unsorted'}" — a manual move drifted it`
    : undefined

  return (
    <tr
      ref={setNodeRef}
      className={rowCls}
      title={hint}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : undefined, touchAction: 'none' }}
      data-mid={mod.mod_id}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        // keyboard-drag only when the row itself is focused — Enter/Space on inner
        // links, buttons and the position input must keep their native behavior
        if (e.target !== e.currentTarget) return
        listeners?.onKeyDown?.(e)
      }}
      onClick={(e) => {
        if (wasDragged.current) {
          wasDragged.current = false
          return
        }
        // interactive elements keep their own behavior; text selection wins
        if ((e.target as Element).closest('input, button, a, select, .posnum, .draghandle')) return
        if (window.getSelection()?.toString()) return
        onRowClick(e)
      }}
    >
      <td style={{ width: 30 }}>
        <span className="draghandle" title={disabled ? 'reordering locked while Claude refines' : 'drag anywhere on the row to reorder'}>
          ≡
        </span>
      </td>
      <RowCells
        mod={mod}
        pos={pos}
        names={names}
        buckets={buckets}
        hl={hl}
        wrong={wrong}
        wrongExpected={wrongExpected}
        mo2Wrong={mo2Wrong}
        disabled={disabled}
        onToggleLock={onToggleLock}
        onMoveTo={onMoveTo}
      />
    </tr>
  )
}
