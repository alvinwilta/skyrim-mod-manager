import { describe, expect, it } from 'vitest'
import { rectFromPoints, intersects } from './marquee'

describe('rectFromPoints', () => {
  it('normalizes any drag direction into a positive box', () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 30, y: 50 })).toEqual({ left: 10, top: 10, width: 20, height: 40 })
    expect(rectFromPoints({ x: 30, y: 50 }, { x: 10, y: 10 })).toEqual({ left: 10, top: 10, width: 20, height: 40 })
  })
})

describe('intersects', () => {
  const box = { left: 10, top: 10, width: 20, height: 20 } // 10..30 × 10..30

  it('overlapping row hits', () => {
    expect(intersects(box, { left: 0, top: 25, right: 100, bottom: 45 })).toBe(true)
  })

  it('row fully inside hits', () => {
    expect(intersects(box, { left: 12, top: 12, right: 28, bottom: 18 })).toBe(true)
  })

  it('row outside misses (below / right)', () => {
    expect(intersects(box, { left: 0, top: 31, right: 100, bottom: 50 })).toBe(false)
    expect(intersects(box, { left: 31, top: 0, right: 50, bottom: 100 })).toBe(false)
  })

  it('touching edges only do not hit (strict inequality)', () => {
    expect(intersects(box, { left: 0, top: 30, right: 100, bottom: 40 })).toBe(false)
  })
})
