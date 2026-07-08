/** Human-readable bytes, ported from the legacy `human()`. */
export function human(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < 3) {
    n /= 1024
    i++
  }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i]
}
