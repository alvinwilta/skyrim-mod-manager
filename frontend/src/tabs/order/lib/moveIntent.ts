import type { OrderMod } from '../../../api/types'

export interface MoveIntent {
  ids: number[]
  position: number
}

/**
 * Resolve a drop into the move the backend understands: dragging a selected
 * row carries the whole selection as a block (legacy block drag); position is
 * the 1-based rank of the row dropped onto, counted over the FULL unfiltered
 * list (legacy data-pos semantics — order_store.move re-ranks around it).
 */
export function resolveMove(
  draggedId: number,
  overId: number,
  selection: ReadonlySet<number>,
  mods: OrderMod[],
): MoveIntent | null {
  if (draggedId === overId) return null
  const position = mods.findIndex((m) => m.mod_id === overId) + 1
  if (position === 0) return null
  const ids = selection.has(draggedId) && selection.size > 1 ? [...selection] : [draggedId]
  return { ids, position }
}
