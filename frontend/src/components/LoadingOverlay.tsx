import type { ReactNode } from 'react'

interface Props {
  message: ReactNode
  detail?: ReactNode
}

/**
 * Full-viewport blocking overlay shown while an irreversible-ish disk job runs
 * (renaming archives). Reuses the dialog dimmer; the message pulses so it reads
 * as "working", and pointer-events on the dimmer swallow every click underneath.
 */
export function LoadingOverlay({ message, detail }: Props) {
  return (
    <div className="dlg-overlay" style={{ zIndex: 30, display: 'grid', placeItems: 'center' }}>
      <div className="dlg-content" style={{ position: 'static', transform: 'none', textAlign: 'center' }}>
        <div className="dlg-title pulse">{message}</div>
        {detail && (
          <div className="dim" style={{ marginTop: 8 }}>
            {detail}
          </div>
        )}
      </div>
    </div>
  )
}
