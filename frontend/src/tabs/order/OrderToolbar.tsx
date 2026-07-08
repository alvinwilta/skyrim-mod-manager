import { PromptEditor } from './PromptEditor'

interface Props {
  model: string
  onModel: (m: string) => void
  refining: boolean
  enforcing: boolean
  committed: boolean // install order committed to disk: no reordering allowed
  onSort: () => void
  onRefine: () => void // toggles to force-stop while refining
  onRefineUncertain: () => void
  onEnforce: () => void
}

export function OrderToolbar({
  model,
  onModel,
  refining,
  enforcing,
  committed,
  onSort,
  onRefine,
  onRefineUncertain,
  onEnforce,
}: Props) {
  return (
    <>
      <div className="toolbar" style={{ margin: 0 }}>
        <button className="btn ghost" disabled={refining || committed} onClick={onSort}>
          Sort (heuristic)
        </button>
        <select
          title="Claude model used to refine the order"
          aria-label="claude model"
          disabled={refining || committed}
          value={model}
          onChange={(e) => onModel(e.target.value)}
        >
          <option value="haiku">Haiku</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
        </select>
        <button
          className="btn"
          style={refining ? { background: '#7f1d1d' } : undefined}
          disabled={committed}
          onClick={onRefine}
        >
          {refining ? 'Force Stop Claude' : 'Refine with Claude'}
        </button>
        <button
          className="btn ghost ai"
          disabled={refining || committed}
          title="Re-checks only mods still flagged UNCERTAIN, using a Nexus summary for extra signal"
          onClick={onRefineUncertain}
        >
          Refine uncertain
        </button>
        <button
          className="btn ghost"
          disabled={refining || enforcing || committed}
          title="Repositions mods that violate a curator-authored before/after/requires rule from an imported collection's own manifest — not a guess"
          onClick={onEnforce}
        >
          Apply collection order rules
        </button>
      </div>
      <PromptEditor />
    </>
  )
}
