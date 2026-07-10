import { memo } from 'react'
import type { DlFile } from '../../api/types'
import { human } from '../../lib/format'

// status → [icon, color class, animation class] (legacy ICON map)
const ICON: Record<string, [string, string, string]> = {
  pending: ['·', 'c-dim', ''],
  url: ['⇄', 'c-blue', 'pulse'],
  queued: ['…', 'c-blue', ''],
  downloading: ['↓', 'c-amber', 'pulse'],
  done: ['✓', 'c-green', ''],
  skipped: ['✓', 'c-dim', ''],
  failed: ['✗', 'c-red', ''],
  expired: ['⟳', 'c-amber', ''], // link expired mid-batch; refreshed next round
}

export const ProgressRow = memo(function ProgressRow({ file, index }: { file: DlFile; index: number }) {
  const [ch, cls, anim] = ICON[file.status] ?? ICON.pending
  const pct = file.size ? Math.min(100, (100 * file.got) / file.size) : file.status === 'done' ? 100 : 0

  return (
    <div className={`row ${file.status}`}>
      <span className="idx">{index + 1}</span>
      <span className={`ico ${cls} ${anim}`}>{ch}</span>
      <span className="name" title={file.name}>
        {file.name}
      </span>
      <span className="size">{human(file.size)}</span>
      <div className="mini">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
})
