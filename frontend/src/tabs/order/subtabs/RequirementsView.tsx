import type { MissingRequirement } from '../../../api/types'
import type { Dismissed } from '../hooks/useDismissed'
import { DismissX, RestoreDismissed } from '../Dismiss'
import { ModJumpLink } from '../ModJump'

export const requirementKey = (m: MissingRequirement) => `${m.mod_name}|${m.requires_mod_id}`

export function RequirementsView({
  msg,
  missing,
  d,
  onJump,
}: {
  msg: string
  missing: MissingRequirement[]
  d: Dismissed
  onJump: (id: number) => void
}) {
  const shown = missing.filter((m) => !d.has(requirementKey(m)))
  return (
    <div>
      <div className="dim">
        {msg} <RestoreDismissed d={d} />
      </div>
      {shown.length > 0 && (
        <div className="grp">
          <h2>
            <span className="badge" style={{ background: '#3a2b12', color: 'var(--amber)' }}>
              Missing requirements · {shown.length}
            </span>
          </h2>
          <ul className="dim dismiss-list">
            {shown.map((m, i) => (
              <li key={i}>
                <DismissX onDismiss={() => d.dismiss(requirementKey(m))} />
                <span style={{ color: 'var(--text)' }}>{m.mod_name}</span> (
                <ModJumpLink id={m.mod_id} name={m.mod_name} onJump={onJump} />) requires{' '}
                <a
                  href={m.requires_url}
                  target="_blank"
                  rel="noreferrer"
                  className="extlink"
                  title="opens the Nexus page in your browser"
                >
                  {m.requires_mod_name ? `${m.requires_mod_name} (${m.requires_mod_id})` : `mod ${m.requires_mod_id}`} ↗
                </a>
                {m.notes ? ` — ${m.notes}` : ''} — not in your library
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
