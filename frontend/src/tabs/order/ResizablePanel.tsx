import { useCallback, useRef, useState, type ReactNode } from 'react'

const PREFIX = 'modman.panelH.'

function loadH(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(PREFIX + key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}

/**
 * A box whose height the user drags via a handle on its bottom edge. The body
 * scrolls when content is taller than the current height. Height is clamped to
 * [min, maxNow] — maxNow also respects the viewport (never taller than 85vh) so
 * it stays responsive on short screens — and persisted per `storageKey`.
 */
export function ResizablePanel({
  storageKey,
  min = 120,
  max = 760,
  initial = 260,
  className = '',
  style,
  children,
}: {
  storageKey: string
  min?: number
  max?: number
  initial?: number
  className?: string
  style?: React.CSSProperties
  children: ReactNode
}) {
  const [h, setH] = useState(() => loadH(storageKey, initial))
  const drag = useRef<{ startY: number; startH: number } | null>(null)

  const maxNow = useCallback(
    () => Math.min(max, Math.round(window.innerHeight * 0.85)),
    [max],
  )
  const clamp = useCallback(
    (v: number) => Math.max(min, Math.min(maxNow(), v)),
    [min, maxNow],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { startY: e.clientY, startH: h }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    setH(clamp(drag.current.startH + (e.clientY - drag.current.startY)))
  }
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return
    drag.current = null
    try {
      localStorage.setItem(PREFIX + storageKey, String(Math.round(h)))
    } catch {
      /* storage unavailable — size just won't persist */
    }
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  return (
    <div className={`rpanel ${className}`} style={{ ...style, height: h }}>
      <div className="rpanel-body">{children}</div>
      <div
        className="rpanel-handle"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  )
}
