import type { ConflictPair } from '../../../api/types'
import type { Dismissed } from '../hooks/useDismissed'
import { DismissX, RestoreDismissed } from '../Dismiss'

/** Stable identity for a pair regardless of a/b order. */
export const conflictKey = (p: ConflictPair) => [p.a.mod_name, p.b.mod_name].sort().join(' vs ')

function ConflictList({ pairs, d }: { pairs: ConflictPair[]; d: Dismissed }) {
  return (
    <ul className="dim dismiss-list">
      {pairs.map((p, i) => (
        <li key={i}>
          <DismissX onDismiss={() => d.dismiss(conflictKey(p))} />
          <span style={{ color: 'var(--text)' }}>{p.a.mod_name}</span> vs{' '}
          <span style={{ color: 'var(--text)' }}>{p.b.mod_name}</span>: {p.paths.length} shared file(s)
        </li>
      ))}
    </ul>
  )
}

export function ConflictsView({ msg, pairs, d }: { msg: string; pairs: ConflictPair[]; d: Dismissed }) {
  const shown = pairs.filter((p) => !d.has(conflictKey(p)))
  const unexpected = shown.filter((p) => !p.expected)
  const expected = shown.filter((p) => p.expected)
  return (
    <div>
      <div className="dim">
        {msg} <RestoreDismissed d={d} />
      </div>
      {unexpected.length > 0 && (
        <details style={{ marginTop: 10 }} open>
          <summary style={{ cursor: 'pointer' }}>
            <span className="badge" style={{ background: '#3a2b12', color: 'var(--amber)' }}>
              Real file conflicts · {unexpected.length} pair(s)
            </span>
          </summary>
          <ConflictList pairs={unexpected} d={d} />
        </details>
      )}
      {expected.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="dim" style={{ cursor: 'pointer' }}>
            Expected overwrites (Foundation/Patches) · {expected.length} pair(s)
          </summary>
          <ConflictList pairs={expected} d={d} />
        </details>
      )}
    </div>
  )
}
