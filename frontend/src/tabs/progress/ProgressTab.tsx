import { useDlEvents, useSpeed } from '../../events/EventsProvider'
import { human } from '../../lib/format'
import { computeStats, formatEta, isLinkPhase } from './lib/speed'
import { ProgressRow } from './ProgressRow'

export function ProgressTab() {
  const dl = useDlEvents()
  const speed = useSpeed()
  const stats = computeStats(dl.files)
  const linkPhase = isLinkPhase(dl.phase)

  const phaseText = linkPhase
    ? `${dl.phase} — ${stats.linksDone}/${stats.total}`
    : dl.phase + (dl.error ? ' — ' + dl.error : '')
  const mainPct = stats.total ? (100 * (linkPhase ? stats.linksDone : stats.finished)) / stats.total : 0

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 15 }}>{phaseText}</h2>
      </div>
      <div className="barwrap">
        <div id="mainbar" style={{ width: `${mainPct}%` }} />
      </div>
      <div className="stats">
        <span>
          <b>{stats.done}</b> / <b>{stats.total}</b> files
        </span>
        {stats.fail > 0 && (
          <span className="c-red">
            failed <b>{stats.fail}</b>
          </span>
        )}
        <span>
          <b>{human(stats.gotBytes)}</b> of <b>{human(stats.totalBytes)}</b>
        </span>
        <span>
          speed <b>{speed > 1 ? human(speed) + '/s' : '—'}</b>
        </span>
        <span>
          ETA <b>{formatEta(speed, stats.totalBytes - stats.gotBytes)}</b>
        </span>
      </div>
      <div style={{ marginTop: 14 }}>
        {dl.files.map((f, i) => (
          <ProgressRow key={f.name} file={f} index={i} />
        ))}
      </div>
    </section>
  )
}
