import { memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

/**
 * A separator band header rendered as a SORTABLE item (id `sep-<sepId>`) so it
 * takes part in dnd-kit's reflow — when a mod is dragged past it, the divider
 * shifts to make room exactly like a row would, instead of staying pinned while
 * the mods swap around it. It is deliberately NOT draggable (no listeners/
 * attributes spread onto it), so the user can't pick a divider up; it only
 * occupies a slot and can be a drop target. Layout animation is off to match the
 * rows (both snap to their virtualizer slots), and the whole order re-groups
 * from data on drop, so the divider always ends where its band actually is.
 */
export const BandDivider = memo(function BandDivider({
  sepId,
  name,
  specialKind,
  collapsed,
  count,
  onToggle,
}: {
  sepId: number
  name: string | undefined
  specialKind: string | null | undefined
  collapsed: boolean
  count: number | undefined
  onToggle: (id: number) => void
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: `sep-${sepId}`,
    animateLayoutChanges: () => false,
  })
  return (
    <button
      ref={setNodeRef}
      className={`band-divider${specialKind ? ` band-${specialKind}` : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => onToggle(sepId)}
      title="click to collapse/expand this band"
    >
      <span className="band-caret">{collapsed ? '▸' : '▾'}</span>
      <span className="band-name">{name ?? sepId}</span>
      <span className="band-count">{count ?? ''}</span>
    </button>
  )
})
