import type { ConflictPair } from '../../../api/types'

function ConflictList({ pairs }: { pairs: ConflictPair[] }) {
  return (
    <ul style={{ margin: '6px 0 0 20px' }} className="dim">
      {pairs.map((p, i) => (
        <li key={i}>
          <span style={{ color: 'var(--text)' }}>{p.a.mod_name}</span> vs{' '}
          <span style={{ color: 'var(--text)' }}>{p.b.mod_name}</span>: {p.paths.length} shared file(s)
        </li>
      ))}
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
        <details style={{ marginTop: 10 }} open>
          <summary style={{ cursor: 'pointer' }}>
            <span className="badge" style={{ background: '#3a2b12', color: 'var(--amber)' }}>
              Real file conflicts · {unexpected.length} pair(s)
            </span>
          </summary>
          <ConflictList pairs={unexpected} />
        </details>
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
