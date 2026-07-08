import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import App from '../../App'
import { FakeEventSource } from '../../test/FakeEventSource'
import { mockApi } from '../../test/mockApi'
import userEvent from '@testing-library/user-event'
import type { EventsFrame } from '../../api/types'

let uninstall: () => void

beforeEach(() => {
  uninstall = FakeEventSource.install()
  mockApi({ 'GET /api/mods': [] }) // default Library tab loads on mount
})

afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
})

const frame = (over: Partial<EventsFrame['dl']>, sortRunning = false): EventsFrame => ({
  dl: { phase: 'idle', files: [], error: null, running: false, ...over },
  sort: { phase: sortRunning ? 'sorting' : 'idle', running: sortRunning, error: null },
})

describe('ProgressTab via SSE', () => {
  it('renders rows from an SSE frame and updates them in place', async () => {
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: 'Progress' }))

    act(() =>
      FakeEventSource.last.emit(
        frame({
          phase: 'downloading',
          running: true,
          files: [
            { name: 'SkyUI_5_2_SE.7z', size: 1000, got: 250, status: 'downloading' },
            { name: 'USSEP.7z', size: 2000, got: 0, status: 'queued' },
          ],
        }),
      ),
    )

    expect(screen.getByText('SkyUI_5_2_SE.7z')).toBeInTheDocument()
    expect(screen.getByText('USSEP.7z')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /downloading/ })).toBeInTheDocument()

    // second frame: first file finishes — same row updates, count moves
    act(() =>
      FakeEventSource.last.emit(
        frame({
          phase: 'downloading',
          running: true,
          files: [
            { name: 'SkyUI_5_2_SE.7z', size: 1000, got: 1000, status: 'done' },
            { name: 'USSEP.7z', size: 2000, got: 500, status: 'downloading' },
          ],
        }),
      ),
    )
    expect(screen.getByText('SkyUI_5_2_SE.7z').closest('.row')).toHaveClass('done')
    expect(screen.getAllByText(/7z$/)).toHaveLength(2) // no duplicated rows
  })

  it('shows link-generation progress by links done, not files finished', async () => {
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: 'Progress' }))

    act(() =>
      FakeEventSource.last.emit(
        frame({
          phase: 'generating links',
          running: true,
          files: [
            { name: 'a.7z', size: 10, got: 0, status: 'queued' },
            { name: 'b.7z', size: 10, got: 0, status: 'url' },
            { name: 'c.7z', size: 10, got: 0, status: 'pending' },
          ],
        }),
      ),
    )
    expect(screen.getByRole('heading', { name: 'generating links — 1/3' })).toBeInTheDocument()
  })

  it('toggles header badges from the SSE frame', async () => {
    render(<App />)
    act(() => FakeEventSource.last.emit(frame({ running: true }, true)))
    expect(screen.getByText('downloading…')).toHaveClass('show')
    expect(screen.getByText('Claude sorting…')).toHaveClass('show')

    act(() => FakeEventSource.last.emit(frame({ running: false }, false)))
    expect(screen.getByText('downloading…')).not.toHaveClass('show')
    expect(screen.getByText('Claude sorting…')).not.toHaveClass('show')
  })

  it('clicking the download badge jumps to the Progress tab', async () => {
    render(<App />)
    act(() => FakeEventSource.last.emit(frame({ phase: 'downloading', running: true })))
    await userEvent.click(screen.getByText('downloading…'))
    expect(screen.getByRole('button', { name: 'Progress' })).toHaveClass('on')
  })
})
