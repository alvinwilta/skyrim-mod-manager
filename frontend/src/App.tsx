import { useEffect, useState } from 'react'
import { TabNav, TAB_IDS, type TabId } from './components/TabNav'
import { EventsProvider, useActivity } from './events/EventsProvider'
import { CollectionsTab } from './tabs/collections/CollectionsTab'
import { ConfigTab } from './tabs/config/ConfigTab'
import { GuideTab } from './tabs/guide/GuideTab'
import { ImportTab, requestCollectionImport } from './tabs/import/ImportTab'
import { LibraryTab } from './tabs/library/LibraryTab'
import { OrderTab } from './tabs/order/OrderTab'
import { ProgressTab } from './tabs/progress/ProgressTab'

const TAB_KEY = 'modman.activeTab'

// localStorage can be undefined (jsdom/SSR) or throw (private mode, blocked
// cookies) — never let tab persistence crash the app over it.
function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// Lazy-init from localStorage so a refresh keeps the tab the user was on;
// validate against the known ids in case a removed/renamed tab was persisted.
function initialTab(): TabId {
  const saved = safeStorage()?.getItem(TAB_KEY)
  return saved && (TAB_IDS as readonly string[]).includes(saved) ? (saved as TabId) : 'library'
}

function Shell() {
  const [tab, setTab] = useState<TabId>(initialTab)
  const { downloading, sorting } = useActivity()

  useEffect(() => {
    safeStorage()?.setItem(TAB_KEY, tab)
  }, [tab])

  return (
    <>
      <TabNav active={tab} onSelect={setTab} downloading={downloading} sorting={sorting} />
      <main>
        {tab === 'library' && <LibraryTab onGoToProgress={() => setTab('progress')} />}
        {tab === 'order' && <OrderTab />}
        {tab === 'collections' && (
          <CollectionsTab
            onImportMods={(url) => {
              requestCollectionImport(url)
              setTab('import')
            }}
          />
        )}
        {tab === 'import' && <ImportTab onGoToProgress={() => setTab('progress')} />}
        {tab === 'progress' && <ProgressTab />}
        {tab === 'guide' && <GuideTab />}
        {tab === 'config' && <ConfigTab />}
      </main>
    </>
  )
}

export default function App() {
  return (
    <EventsProvider>
      <Shell />
    </EventsProvider>
  )
}
