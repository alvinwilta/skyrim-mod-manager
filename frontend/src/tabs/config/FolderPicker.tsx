import { useEffect, useState } from 'react'
import { api } from '../../api/endpoints'
import { ApiError } from '../../api/client'
import type { BrowseResult } from '../../api/types'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

// Backend-driven directory browser: the browser can't read absolute paths from
// a file input (security), so navigation goes through /api/browse. Click a
// subfolder to descend, ".." to go up, then Select to hand the path back.
export function FolderPicker({
  title,
  start,
  onPick,
  onClose,
}: {
  title: string
  start?: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [data, setData] = useState<BrowseResult | null>(null)
  const [error, setError] = useState('')

  const go = (path?: string) => {
    setError('')
    api
      .browse(path)
      .then(setData)
      .catch((e) => setError(errText(e)))
  }

  useEffect(() => go(start || undefined), [start])

  return (
    <div className="fp-overlay" onClick={onClose}>
      <div className="fp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fp-head">
          <span>{title}</span>
          <button className="fp-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="fp-path">{data?.path ?? '…'}</div>
        {error && <p className="config-error">{error}</p>}
        <ul className="fp-list">
          {data && data.path !== data.parent && (
            <li className="fp-up" onClick={() => go(data.parent)}>
              ‹ ..
            </li>
          )}
          {data?.dirs.map((d) => {
            const full = data.path.replace(/\/$/, '') + '/' + d
            return (
              <li key={d} onClick={() => go(full)}>
                <span className="fp-ico" aria-hidden="true">
                  📁
                </span>
                {d}
              </li>
            )
          })}
          {data && data.dirs.length === 0 && <li className="fp-empty">(no subfolders)</li>}
        </ul>
        <div className="fp-actions">
          <button className="btn" onClick={() => data && onPick(data.path)} disabled={!data}>
            Select this folder
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
