import type { MissingRequirement } from '../../../api/types'

export function RequirementsView({ msg, missing }: { msg: string; missing: MissingRequirement[] }) {
  return (
    <div>
      <div className="dim">{msg}</div>
      {missing.length > 0 && (
        <div className="grp">
          <h2>
            <span className="badge" style={{ background: '#3a2b12', color: 'var(--amber)' }}>
              Missing requirements · {missing.length}
            </span>
          </h2>
          <ul style={{ margin: '6px 0 0 20px' }} className="dim">
            {missing.slice(0, 30).map((m, i) => (
              <li key={i}>
                {m.mod_name} requires{' '}
                <a href={m.requires_url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                  mod {m.requires_mod_id}
                </a>
                {m.notes ? ` — ${m.notes}` : ''} — not in your library
              </li>
            ))}
            {missing.length > 30 && <li>...and {missing.length - 30} more</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
