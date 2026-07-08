import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { rectFromPoints, intersects, type Box, type Point } from '../lib/marquee'

interface Opts {
  /** Called once when the drag passes the activation threshold. */
  onStart: () => void
  /** Called on every move with the mod_ids intersecting the box. */
  onHit: (mids: number[], additive: boolean) => void
}

/**
 * Rubber-band row selection: press on non-interactive row space and drag —
 * a box appears and every intersecting `tr.ordrow` is selected live.
 * Ctrl/cmd-drag adds to the existing selection. A sub-5px press stays a
 * plain click (row-click selection handles that).
 */
export function useMarquee({ onStart, onHit }: Opts) {
  const [box, setBox] = useState<Box | null>(null)
  const opts = useRef({ onStart, onHit })
  opts.current = { onStart, onHit }

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as Element
    // interactive elements keep their own behavior; the ≡ handle owns dnd
    if (target.closest('input, button, a, select, .draghandle, .posnum')) return

    // Otherwise the browser starts native text selection and the marquee
    // never wins (rows are also user-select:none in CSS as belt+braces).
    e.preventDefault()

    const container = e.currentTarget
    const start: Point = { x: e.clientX, y: e.clientY }
    const additive = e.ctrlKey || e.metaKey
    let active = false

    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return
      if (!active) {
        active = true
        document.body.style.userSelect = 'none' // no text selection mid-drag
        opts.current.onStart()
      }
      const b = rectFromPoints(start, { x: ev.clientX, y: ev.clientY })
      setBox(b)
      const hits: number[] = []
      container.querySelectorAll<HTMLElement>('tr.ordrow').forEach((row) => {
        if (intersects(b, row.getBoundingClientRect())) hits.push(Number(row.dataset.mid))
      })
      opts.current.onHit(hits, additive)
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      if (active) {
        // swallow the click that follows the drag — it would re-select one row
        window.addEventListener(
          'click',
          (ce) => {
            ce.stopPropagation()
            ce.preventDefault()
          },
          { capture: true, once: true },
        )
      }
      setBox(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  return { box, onPointerDown }
}
