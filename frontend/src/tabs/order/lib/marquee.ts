export interface Point {
  x: number
  y: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export const rectFromPoints = (a: Point, b: Point): Box => ({
  left: Math.min(a.x, b.x),
  top: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
})

export const intersects = (box: Box, r: { left: number; top: number; right: number; bottom: number }): boolean =>
  box.left < r.right && box.left + box.width > r.left && box.top < r.bottom && box.top + box.height > r.top
