import { HIGHLIGHT_CHIPS, type HighlightKey, type Highlights } from './lib/highlights'

interface Props {
  hl: Highlights
  counts: Record<HighlightKey, number>
  onToggle: (key: HighlightKey) => void
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

export function HighlightBar({ hl, counts, onToggle, showLocked, onToggleLocked, lockedCount }: Props) {
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
        <Chip
          key={c.key}
          on={hl[c.key]}
          color={c.color}
          bg={c.bg}
          label={`${c.label} (${counts[c.key]})`}
          title={c.title}
          onClick={() => onToggle(c.key)}
        />
      ))}
    </div>
  )
}
