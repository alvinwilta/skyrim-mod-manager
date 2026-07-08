import { useEffect, useRef } from 'react'

/**
 * Pin a sticky element right below the (wrappable) app header: keeps
 * `style.top` equal to the header's current height (legacy setSticky()).
 */
export function useStickyTop<T extends HTMLElement>() {
  const ref = useRef<T>(null)

  useEffect(() => {
    const header = document.querySelector('header')
    if (!header || !ref.current) return
    const apply = () => {
      if (ref.current) ref.current.style.top = header.getBoundingClientRect().height + 'px'
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(header)
    return () => ro.disconnect()
  }, [])

  return ref
}
