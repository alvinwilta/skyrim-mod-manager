import { useState } from 'react'
import { TabNav, type TabId } from './components/TabNav'
import { EventsProvider, useActivity } from './events/EventsProvider'
import { CollectionsTab } from './tabs/collections/CollectionsTab'
import { GuideTab } from './tabs/guide/GuideTab'
import { ImportTab } from './tabs/import/ImportTab'
import { LibraryTab } from './tabs/library/LibraryTab'
import { OrderTab } from './tabs/order/OrderTab'
import { ProgressTab } from './tabs/progress/ProgressTab'

function Shell() {
  const [tab, setTab] = useState<TabId>('library')
  const { downloading, sorting } = useActivity()

  return (
    <>
      <TabNav active={tab} onSelect={setTab} downloading={downloading} sorting={sorting} />
      <main>
        {tab === 'library' && <LibraryTab onGoToProgress={() => setTab('progress')} />}
        {tab === 'order' && <OrderTab />}
        {tab === 'collections' && <CollectionsTab />}
        {tab === 'import' && <ImportTab onGoToProgress={() => setTab('progress')} />}
        {tab === 'progress' && <ProgressTab />}
        {tab === 'guide' && <GuideTab />}
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
