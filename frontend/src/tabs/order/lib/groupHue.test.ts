import { describe, expect, it } from 'vitest'
import { groupHue } from './groupHue'

describe('groupHue', () => {
  it('matches the legacy golden-angle formula', () => {
    expect(groupHue(0)).toBe(0)
    expect(groupHue(1)).toBe(Math.round(137.508 % 360))
    expect(groupHue(3)).toBe(Math.round((3 * 137.508) % 360))
    expect(groupHue(20)).toBe(Math.round((20 * 137.508) % 360))
  })

  it('is stable and within [0, 360)', () => {
    for (let b = 0; b < 40; b++) {
      const h = groupHue(b)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
      expect(groupHue(b)).toBe(h)
    }
  })
})
