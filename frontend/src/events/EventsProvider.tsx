import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { useSSE } from '../hooks/useSSE'
import type { DlState, EventsFrame, JobState } from '../api/types'
import { computeStats, updateSpeed, type SpeedSample } from '../tabs/progress/lib/speed'

const IDLE_DL: DlState = { phase: 'idle', files: [], error: null, running: false }
const IDLE_SORT: JobState = { phase: 'idle', running: false, error: null }

export interface Events {
  dl: DlState
  sort: JobState
  /** Smoothed transfer speed (bytes/s). Lives here, not in ProgressTab, so it
   *  survives tab switches (the legacy page computed it on every SSE frame). */
  speed: number
  connected: boolean
}

const EventsContext = createContext<Events>({ dl: IDLE_DL, sort: IDLE_SORT, speed: 0, connected: false })

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

  return <EventsContext.Provider value={{ dl, sort, speed, connected }}>{children}</EventsContext.Provider>
}

export const useEvents = () => useContext(EventsContext)
