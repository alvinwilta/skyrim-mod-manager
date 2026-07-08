export type TabId = 'library' | 'order' | 'collections' | 'import' | 'progress' | 'guide'

const TABS: { id: TabId; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'order', label: 'Install Order' },
  { id: 'collections', label: 'Collections' },
  { id: 'import', label: 'Import' },
  { id: 'progress', label: 'Progress' },
  { id: 'guide', label: 'Guide' },
]

interface Props {
  active: TabId
  onSelect: (tab: TabId) => void
  // Header badges (P2): shown while a download / Claude sort is running.
  downloading?: boolean
  sorting?: boolean
}

export function TabNav({ active, onSelect, downloading, sorting }: Props) {
  return (
    <header>
      <h1>Mod Manager</h1>
      <nav>
        {TABS.map((t) => (
          <button key={t.id} className={t.id === active ? 'on' : ''} onClick={() => onSelect(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <span id="badges">
        <span id="runbadge" className={downloading ? 'show' : ''} onClick={() => onSelect('progress')}>
          downloading…
        </span>
        <span id="sortbadge" className={sorting ? 'show' : ''} onClick={() => onSelect('order')}>
          Claude sorting…
        </span>
      </span>
    </header>
  )
}
