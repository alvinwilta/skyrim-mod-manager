import type { Dismissed } from './hooks/useDismissed'

/** Per-line × — hides the line until the producing job reruns. */
export function DismissX({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      className="li-x"
      title="Dismiss — hidden until the next scan"
      aria-label="Dismiss"
      onClick={(e) => {
        e.stopPropagation()
        onDismiss()
      }}
    >
      ×
    </button>
  )
}

/** Undo link shown while a section has dismissed lines. */
export function RestoreDismissed({ d }: { d: Dismissed }) {
  if (!d.count) return null
  return (
    <button className="dismiss-restore" onClick={d.clear}>
      restore {d.count} dismissed
    </button>
  )
}
