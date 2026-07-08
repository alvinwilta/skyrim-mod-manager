import { useEffect, useState } from 'react'

/** Returns `value` after it has been stable for `ms` (legacy search: 250ms). */
export function useDebounce<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])

  return debounced
}
