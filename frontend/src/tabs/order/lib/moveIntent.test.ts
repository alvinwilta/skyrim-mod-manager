import { describe, expect, it } from 'vitest'
import { resolveMove } from './moveIntent'
import type { OrderMod } from '../../../api/types'

const m = (mod_id: number): OrderMod => ({
  mod_id,
  mod_name: `mod${mod_id}`,
  mod_url: '',
  category: null,
  bucket: null,
  locked: false,
  installed: false,
  mo2_state: null,
  source: null,
  separator_id: null,
  file_type: null,
  flags: [],
})
const mods = [m(10), m(20), m(30), m(40)]

// `position` is the 1-based slot in the list WITHOUT the moving rows
// (order_store.move removes the block, then inserts at position-1).
describe('resolveMove', () => {
  it('single drag down → lands after the drop row', () => {
    // remove 10 → [20,30,40]; insert at slot 3 → [20,30,10,40]
    expect(resolveMove(10, 30, new Set(), mods)).toEqual({ ids: [10], position: 3 })
  })

  it('single drag up → lands before the drop row', () => {
    // remove 40 → [10,20,30]; insert at slot 2 → [10,40,20,30]
    expect(resolveMove(40, 20, new Set(), mods)).toEqual({ ids: [40], position: 2 })
  })

  it('dragging a selected row carries the whole selection', () => {
    // remove 10,20 → [30,40]; insert at slot 3 → [30,40,10,20]
    expect(resolveMove(10, 40, new Set([10, 20]), mods)).toEqual({ ids: [10, 20], position: 3 })
  })

  it('block drag counts the slot without the moving rows (the shifted-drop bug)', () => {
    // 8 mods, drag 2,3,4 down onto 6: without the block [1,5,6,7,8], 6 sits at
    // slot 3, block lands after it → position 4 → [1,5,6,2,3,4,7,8].
    // The old full-list count sent 6 → block landed two rows too low.
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map(m)
    expect(resolveMove(2, 6, new Set([2, 3, 4]), eight)).toEqual({ ids: [2, 3, 4], position: 4 })
  })

  it('dragging an UNselected row moves only itself even with a selection', () => {
    expect(resolveMove(30, 10, new Set([10, 20]), mods)).toEqual({ ids: [30], position: 1 })
  })

  it('drop on itself, the dragged block, or unknown target → null', () => {
    expect(resolveMove(10, 10, new Set(), mods)).toBeNull()
    expect(resolveMove(10, 999, new Set(), mods)).toBeNull()
    expect(resolveMove(10, 20, new Set([10, 20, 30]), mods)).toBeNull()
  })
})
