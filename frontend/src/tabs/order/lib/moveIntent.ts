import type { OrderMod } from '../../../api/types'

export interface MoveIntent {
  ids: number[]
  position: number
}

/**
 * A cell in the rendered order: either a band divider (modId null, band = the
 * separator id) or a mod (modId set, band = its separator_id). `id` is the
 * dnd-kit sortable id — `sep-<id>` for dividers, the numeric mod_id for mods —
 * so BOTH participate in the sortable reflow (dividers are sortable items too,
 * just not draggable). Keeping dividers in the item list is what stops dnd-kit
 * from reordering mods *around* a fixed divider (the "B / sep / A" swap bug).
 */
export interface DropCell {
  id: string | number
  band: number | null
  modId: number | null
}

export interface DropResult {
  ids: number[]
  /** 1-based slot among the NON-moving mods (order_store.move semantics). */
  position: number
  /** band the block lands in (the divider above its new spot), or null. */
  separatorId: number | null
}

/**
 * Resolve a drop in the COMBINED (divider-interleaved) space. Works whether the
 * drop landed on a mod or on a divider, and derives the destination band from
 * the divider that ends up above the block — so a drag across a divider both
 * reorders AND re-bands correctly, and the live drag preview (which now includes
 * the divider) matches the committed result.
 */
export function resolveDrop(
  cells: DropCell[],
  activeId: number,
  overId: string | number,
  selection: ReadonlySet<number>,
): DropResult | null {
  if (activeId === overId) return null
  const ids = selection.has(activeId) && selection.size > 1 ? [...selection] : [activeId]
  const moving = new Set(ids)
  const activeIdx = cells.findIndex((c) => c.id === activeId)
  const overIdx = cells.findIndex((c) => c.id === overId)
  if (activeIdx < 0 || overIdx < 0) return null
  const overCell = cells[overIdx]
  if (overCell.modId != null && moving.has(overCell.modId)) return null // onto own block

  // list without the moving mods (dividers stay), and where `over` sits in it
  const rest = cells.filter((c) => c.modId == null || !moving.has(c.modId))
  const overInRest = rest.findIndex((c) => c.id === overId)
  if (overInRest < 0) return null
  // below the origin → after the drop cell; above → before it (dnd-kit arrayMove)
  const insertAt = activeIdx < overIdx ? overInRest + 1 : overInRest

  const movingCells: DropCell[] = ids.map((id) => ({ id, band: null, modId: id }))
  const final = [...rest.slice(0, insertAt), ...movingCells, ...rest.slice(insertAt)]

  // band = the divider above the block's new position; position = non-moving
  // mods before the block + 1
  let band: number | null = null
  let before = 0
  for (const c of final) {
    if (c.id === ids[0]) break
    if (c.modId == null) band = c.band
    else if (!moving.has(c.modId)) before++
  }
  return { ids, position: before + 1, separatorId: band }
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
