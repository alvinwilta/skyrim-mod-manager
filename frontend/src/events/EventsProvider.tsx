import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSSE } from '../hooks/useSSE'
import type { DlState, EventsFrame, JobState } from '../api/types'
import { computeStats, updateSpeed, type SpeedSample } from '../tabs/progress/lib/speed'

const IDLE_DL: DlState = { phase: 'idle', files: [], error: null, running: false }
const IDLE_SORT: JobState = { phase: 'idle', running: false, error: null }

/** Coarse job activity: changes only when a job starts/ends, not per frame. */
export interface Activity {
  downloading: boolean
  sorting: boolean
  connected: boolean
}

// Split contexts: SSE pushes a frame every ~0.3s while any job runs, and one
// context holding dl+sort+speed re-rendered the ENTIRE app per frame. Most
// consumers (tab badges, "reload when the download ends", the refine bridge)
// only care about the running booleans — they subscribe to Activity, which
// keeps a stable identity until a boolean actually flips. Only ProgressTab
// subscribes to the per-frame dl/speed streams.
const DlContext = createContext<DlState>(IDLE_DL)
const SortContext = createContext<JobState>(IDLE_SORT)
const SpeedContext = createContext<number>(0)
const ActivityContext = createContext<Activity>({ downloading: false, sorting: false, connected: false })

export function EventsProvider({ children }: { children: ReactNode }) {
  const [dl, setDl] = useState<DlState>(IDLE_DL)
  const [sort, setSort] = useState<JobState>(IDLE_SORT)
  const [speed, setSpeed] = useState(0)
  const sample = useRef<{ speed: number; prev: SpeedSample | null }>({ speed: 0, prev: null })

  const { connected } = useSSE<EventsFrame>('/api/events', (frame) => {
    setDl(frame.dl)
    setSort(frame.sort)
    const { gotBytes } = computeStats(frame.dl.files)
    sample.current = updateSpeed(sample.current.speed, sample.current.prev, performance.now(), gotBytes)
    setSpeed(sample.current.speed)
  })

  const activity = useMemo(
    () => ({ downloading: dl.running, sorting: sort.running, connected }),
    [dl.running, sort.running, connected],
  )

  return (
    <ActivityContext.Provider value={activity}>
      <DlContext.Provider value={dl}>
        <SortContext.Provider value={sort}>
          <SpeedContext.Provider value={speed}>{children}</SpeedContext.Provider>
        </SortContext.Provider>
      </DlContext.Provider>
    </ActivityContext.Provider>
  )
}

/** Per-frame download state — subscribe only where live progress is shown. */
export const useDlEvents = () => useContext(DlContext)
/** Per-frame sort/refine state. */
export const useSortEvents = () => useContext(SortContext)
/** Smoothed transfer speed (bytes/s). Survives tab switches. */
export const useSpeed = () => useContext(SpeedContext)
/** Coarse running booleans — the right subscription for everything else. */
export const useActivity = () => useContext(ActivityContext)
