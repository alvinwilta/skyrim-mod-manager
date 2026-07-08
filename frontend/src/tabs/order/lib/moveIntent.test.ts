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
  file_type: null,
  flags: [],
})
const mods = [m(10), m(20), m(30), m(40)]

describe('resolveMove', () => {
  it('single drag → the dragged id at the drop row rank', () => {
    expect(resolveMove(10, 30, new Set(), mods)).toEqual({ ids: [10], position: 3 })
  })

  it('dragging a selected row carries the whole selection', () => {
    expect(resolveMove(10, 40, new Set([10, 20]), mods)).toEqual({ ids: [10, 20], position: 4 })
  })

  it('dragging an UNselected row moves only itself even with a selection', () => {
    expect(resolveMove(30, 10, new Set([10, 20]), mods)).toEqual({ ids: [30], position: 1 })
  })

  it('drop on itself or unknown target → null', () => {
    expect(resolveMove(10, 10, new Set(), mods)).toBeNull()
    expect(resolveMove(10, 999, new Set(), mods)).toBeNull()
  })
})
