import type { ConflictPair } from '../../../api/types'
import type { Dismissed } from '../hooks/useDismissed'
import { DismissX, RestoreDismissed } from '../Dismiss'
import { ModJumpLink } from '../ModJump'

/** Stable identity for a pair regardless of a/b order. */
export const conflictKey = (p: ConflictPair) => [p.a.mod_name, p.b.mod_name].sort().join(' vs ')

function Side({ side, onJump }: { side: ConflictPair['a']; onJump: (id: number) => void }) {
  return (
    <>
      <span style={{ color: 'var(--text)' }}>{side.mod_name}</span> (
      <ModJumpLink id={side.mod_id} name={side.mod_name} onJump={onJump} />)
    </>
  )
}

function ConflictList({ pairs, d, onJump }: { pairs: ConflictPair[]; d: Dismissed; onJump: (id: number) => void }) {
  return (
    <ul className="dim dismiss-list">
      {pairs.map((p, i) => (
        <li key={i}>
          <DismissX onDismiss={() => d.dismiss(conflictKey(p))} />
          <Side side={p.a} onJump={onJump} /> vs <Side side={p.b} onJump={onJump} />: {p.paths.length} shared file(s)
        </li>
      ))}
    </ul>
  )
}

export function ConflictsView({
  msg,
  pairs,
  d,
  onJump,
}: {
  msg: string
  pairs: ConflictPair[]
  d: Dismissed
  onJump: (id: number) => void
}) {
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
          <ConflictList pairs={unexpected} d={d} onJump={onJump} />
        </details>
      )}
      {expected.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="dim" style={{ cursor: 'pointer' }}>
            Expected overwrites (Foundation/Patches) · {expected.length} pair(s)
          </summary>
          <ConflictList pairs={expected} d={d} onJump={onJump} />
        </details>
      )}
    </div>
  )
}
