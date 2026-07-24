import { describe, expect, it } from 'vitest'
import { flagCategory } from './highlights'

describe('flagCategory', () => {
  it('maps each tag prefix to its toggle', () => {
    expect(flagCategory('DUPLICATE:7')).toBe('duplicate')
    expect(flagCategory('MOVED:3>5')).toBe('moved')
    expect(flagCategory('UNCERTAIN')).toBe('uncertain')
  })

  it('unknown flags return null so they are never hidden', () => {
    expect(flagCategory('SOMETHING_NEW')).toBeNull()
  })
})
