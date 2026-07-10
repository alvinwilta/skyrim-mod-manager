import { HIGHLIGHT_CHIPS, type HighlightKey, type Highlights } from './lib/highlights'

interface Props {
  hl: Highlights
  counts: Record<HighlightKey, number>
  onToggle: (key: HighlightKey) => void
  onClear: (key: HighlightKey) => void
  showLocked: boolean
  onToggleLocked: () => void
  lockedCount: number
}

function Chip({ on, color, bg, label, title, onClick }: { on: boolean; color: string; bg: string; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`chip${on ? ' on' : ''}`}
      title={title}
      aria-pressed={on}
      onClick={onClick}
      style={on ? { background: bg, color } : undefined}
    >
      {label}
    </button>
  )
}

export function HighlightBar({ hl, counts, onToggle, onClear, showLocked, onToggleLocked, lockedCount }: Props) {
  return (
    <div className="hlbar">
      <span className="dim" style={{ fontSize: 12 }}>
        Highlights:
      </span>
      <Chip
        on={showLocked}
        color="var(--blue)"
        bg="#1d2a45"
        label={`🔒 Locked${lockedCount ? ` (${lockedCount})` : ''}`}
        title="Show or hide locked rows. Hidden locked rows keep their place — moving other mods stays relative to them."
        onClick={onToggleLocked}
      />
      {HIGHLIGHT_CHIPS.map((c) => (
        <span key={c.key} className="chipgroup">
          <Chip
            on={hl[c.key]}
            color={c.color}
            bg={c.bg}
            label={`${c.label} (${counts[c.key]})`}
            title={c.title}
            onClick={() => onToggle(c.key)}
          />
          {counts[c.key] > 0 && (
            <button
              type="button"
              className="chip chip-clear"
              title={
                c.key === 'drift'
                  ? 'Clear this drift check result (run Check for drift again to re-flag)'
                  : `Clear all ${c.label.toLowerCase()} tags permanently — the next Sort/Refine re-adds any that still apply`
              }
              aria-label={`clear ${c.label.toLowerCase()} tags`}
              onClick={() => onClear(c.key)}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  )
}
