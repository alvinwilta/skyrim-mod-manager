import type { OrderMod } from '../../../api/types'

export interface MoveIntent {
  ids: number[]
  position: number
}

/**
 * Resolve a drop into the move the backend understands: dragging a selected
 * row carries the whole selection as a block. `position` is the 1-based slot
 * in the list WITHOUT the moving rows — exactly how order_store.move (and
 * reorderLocal) apply it: remove the block, insert at position-1. Counting
 * the slot over the full list instead was the multi-drag bug: every moved
 * row above the target shifted the block one row past where it was dropped.
 *
 * Direction rule (same as dnd-kit's arrayMove for single rows): dropping
 * below the origin lands the block AFTER the drop row, above lands it
 * BEFORE — so the drop preview and the persisted order agree.
 */
export function resolveMove(
  draggedId: number,
  overId: number,
  selection: ReadonlySet<number>,
  mods: OrderMod[],
): MoveIntent | null {
  if (draggedId === overId) return null
  const ids = selection.has(draggedId) && selection.size > 1 ? [...selection] : [draggedId]
  const moving = new Set(ids)
  if (moving.has(overId)) return null // dropped onto the dragged block itself
  const overIdx = mods.findIndex((m) => m.mod_id === overId)
  const activeIdx = mods.findIndex((m) => m.mod_id === draggedId)
  if (overIdx < 0 || activeIdx < 0) return null
  let overIdxRest = 0 // the drop row's index once the moving rows are gone
  for (let i = 0; i < overIdx; i++) if (!moving.has(mods[i].mod_id)) overIdxRest++
  const insertAt = activeIdx < overIdx ? overIdxRest + 1 : overIdxRest
  return { ids, position: insertAt + 1 }
}
