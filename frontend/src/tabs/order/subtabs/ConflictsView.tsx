import type { ConflictPair } from '../../../api/types'

function ConflictList({ pairs }: { pairs: ConflictPair[] }) {
  return (
    <ul style={{ margin: '6px 0 0 20px' }} className="dim">
      {pairs.slice(0, 30).map((p, i) => (
        <li key={i}>
          {p.a.mod_name} vs {p.b.mod_name}: {p.paths.length} shared file(s)
        </li>
      ))}
      {pairs.length > 30 && <li>...and {pairs.length - 30} more pair(s)</li>}
    </ul>
  )
}

export function ConflictsView({ msg, pairs }: { msg: string; pairs: ConflictPair[] }) {
  const unexpected = pairs.filter((p) => !p.expected)
  const expected = pairs.filter((p) => p.expected)
  return (
    <div>
      <div className="dim">{msg}</div>
      {unexpected.length > 0 && (
        <div className="grp">
          <h2>
            <span className="badge" style={{ background: '#3a2b12', color: 'var(--amber)' }}>
              Real file conflicts · {unexpected.length} pair(s)
            </span>
          </h2>
          <ConflictList pairs={unexpected} />
        </div>
      )}
      {expected.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="dim" style={{ cursor: 'pointer' }}>
            Expected overwrites (Foundation/Patches) · {expected.length} pair(s)
          </summary>
          <ConflictList pairs={expected} />
        </details>
      )}
    </div>
  )
}
