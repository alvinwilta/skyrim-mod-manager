import { PromptEditor } from './PromptEditor'

interface Props {
  model: string
  onModel: (m: string) => void
  refining: boolean
  enforcing: boolean
  onSort: () => void
  onRefine: () => void // toggles to force-stop while refining
  onRefineUncertain: () => void
  onEnforce: () => void
  msg: string
}

export function OrderToolbar({
  model,
  onModel,
  refining,
  enforcing,
  onSort,
  onRefine,
  onRefineUncertain,
  onEnforce,
  msg,
}: Props) {
  return (
    <div className="toolgroup">
      <div className="toolgroup-h">
        <span className="toolgroup-label">Ordering</span>
        <span className="dim" style={{ fontSize: 12 }}>
          Everything that builds or changes the order — heuristic sort, Claude refine, apply curated collection rules.
        </span>
      </div>
      <div className="toolbar" style={{ margin: 0 }}>
        <button className="btn ghost" disabled={refining} onClick={onSort}>
          Sort (heuristic)
        </button>
        <select
          title="Claude model used to refine the order"
          aria-label="claude model"
          disabled={refining}
          value={model}
          onChange={(e) => onModel(e.target.value)}
        >
          <option value="haiku">Haiku</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
        </select>
        <button className="btn" style={refining ? { background: '#7f1d1d' } : undefined} onClick={onRefine}>
          {refining ? 'Force Stop Claude' : 'Refine with Claude'}
        </button>
        <button
          className="btn ghost ai"
          disabled={refining}
          title="Re-checks only mods still flagged UNCERTAIN, using a Nexus summary for extra signal"
          onClick={onRefineUncertain}
        >
          Refine uncertain
        </button>
        <button
          className="btn ghost"
          disabled={refining || enforcing}
          title="Repositions mods that violate a curator-authored before/after/requires rule from an imported collection's own manifest — not a guess"
          onClick={onEnforce}
        >
          Apply collection order rules
        </button>
      </div>
      <PromptEditor />
      <div className="dim" style={{ marginTop: 8 }}>
        {msg}
      </div>
    </div>
  )
}
