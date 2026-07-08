import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { OrderMod } from '../../api/types'
import { FlagBadge } from './FlagBadges'
import { GroupBadge } from './GroupBadge'

interface Props {
  mod: OrderMod
  pos: number
  names: ReadonlyMap<number, string>
  buckets: Record<string, string>
  selected: boolean
  wrongExpected: number | null | undefined // bucket id when drift-flagged
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

export function OrderRow({
  mod,
  pos,
  names,
  buckets,
  selected,
  wrongExpected,
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

  const wrong = wrongExpected !== undefined
  const moved = mod.flags?.some((f) => f.startsWith('MOVED')) || justChanged
  const rowCls = ['ordrow', wrong ? 'r-wrong' : moved ? 'r-upd' : mod.locked ? 'r-locked' : '', selected ? 'r-sel' : '']
    .filter(Boolean)
    .join(' ')
  const hint = wrong ? `expected: ${wrongExpected ?? '?'} · ${buckets[String(wrongExpected)] || 'unsorted'}` : undefined

  return (
    <tr
      ref={setNodeRef}
      className={rowCls}
      title={hint}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : undefined }}
      data-mid={mod.mod_id}
      onClick={(e) => {
        // interactive elements keep their own behavior; text selection wins
        if ((e.target as Element).closest('input, button, a, select, .posnum, .draghandle')) return
        if (window.getSelection()?.toString()) return
        onRowClick(e)
      }}
    >
      <td style={{ width: 30 }}>
        <span
          className="draghandle"
          title={disabled ? 'reordering locked while Claude refines' : 'drag to reorder'}
          {...attributes}
          {...listeners}
        >
          ≡
        </span>
      </td>
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
        {(mod.flags || []).map((f) => (
          <FlagBadge key={f} flag={f} names={names} buckets={buckets} />
        ))}
        {wrong && <FlagBadge flag="WRONG SPOT" names={names} buckets={buckets} />}
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
    </tr>
  )
}
