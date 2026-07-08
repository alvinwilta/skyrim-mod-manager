import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LibraryTab } from './LibraryTab'
import { EventsProvider } from '../../events/EventsProvider'
import { mockApi } from '../../test/mockApi'
import { FakeEventSource } from '../../test/FakeEventSource'
import type { Mod } from '../../api/types'

let uninstall: () => void
beforeEach(() => {
  uninstall = FakeEventSource.install()
})
afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Set an input's value through the native setter so React's value tracker
 *  registers the change (a plain `.value =` is invisible to React). */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const mod = (over: Partial<Mod>): Mod => ({
  file_id: 1,
  mod_id: 1,
  mod_name: 'SkyUI',
  mod_url: 'https://nexus/skyui',
  file_name: 'SkyUI_5_2.7z',
  filename: 'SkyUI_5_2.7z',
  file_version: '5.2',
  author: 'schlangster',
  category: 'UI',
  size_bytes: 1024,
  downloaded_at: '2026-01-01T10:00:00',
  status: 'ok',
  installed: false,
  collections: [],
  ...over,
})

// LibraryTab.load() also fetches commit-state (to disable delete/redownload when
// the order is committed to disk). Inject an idle default into every route table.
const COMMIT_IDLE = { running: false, phase: 'idle', error: null, committed: false }
const mockLib = (routes: Record<string, unknown>) =>
  mockApi({ 'GET /api/order/commit-state': COMMIT_IDLE, ...routes })

const renderTab = (onGoToProgress = vi.fn()) =>
  render(
    <EventsProvider>
      <LibraryTab onGoToProgress={onGoToProgress} />
    </EventsProvider>,
  )

describe('LibraryTab', () => {
  it('loads and renders rows; deleted hidden by default with count hint', async () => {
    mockLib({
      'GET /api/mods': [
        mod({ file_id: 1 }),
        mod({ file_id: 2, mod_name: 'USSEP', file_name: 'ussep.7z', status: 'deleted' }),
      ],
    })
    renderTab()
    expect(await screen.findByText('SkyUI')).toBeInTheDocument()
    expect(screen.queryByText('USSEP')).not.toBeInTheDocument()
    expect(screen.getByText('1 files (1 deleted hidden)')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Show deleted (1)' }))
    expect(await screen.findByText('USSEP')).toBeInTheDocument()
  })

  it('debounces search input into a single query fetch', async () => {
    vi.useFakeTimers()
    const { calls } = mockLib({ 'GET /api/mods': [mod({})] })
    renderTab()
    await act(async () => {}) // initial load
    const modCalls = () => calls.filter((c) => c.path === '/api/mods').length
    const initial = modCalls()

    const input = screen.getByPlaceholderText(/Search name/) as HTMLInputElement
    // type without fake-timer-aware userEvent: fire changes directly
    for (const v of ['s', 'sk', 'sky']) {
      act(() => setInputValue(input, v))
      act(() => {
        vi.advanceTimersByTime(100)
      })
    }
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(modCalls()).toBe(initial + 1) // one fetch for three keystrokes
    expect(calls.filter((c) => c.path === '/api/mods').at(-1)?.path).toBe('/api/mods')
  })

  it('delete: confirm dialog → POST selected ids → message + reload', async () => {
    const rows = [mod({ file_id: 7 }), mod({ file_id: 8, mod_name: 'USSEP', file_name: 'ussep.7z' })]
    const { calls } = mockLib({
      'GET /api/mods': rows,
      'POST /api/delete': { deleted: 2, files_removed: 2 },
    })
    renderTab()
    await screen.findByText('SkyUI')

    await userEvent.click(screen.getByLabelText('select all'))
    await userEvent.click(screen.getByRole('button', { name: 'Delete (2)' }))
    // Radix confirm dialog replaces window.confirm
    expect(await screen.findByText('Delete 2 file(s)?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    const del = calls.find((c) => c.path === '/api/delete')
    expect(del?.body).toEqual({ file_ids: [7, 8] })
    expect(await screen.findByText('2 marked deleted · 2 file(s) removed from disk')).toBeInTheDocument()
  })

  it('surfaces {error} responses in the message area', async () => {
    mockLib({
      'GET /api/mods': [mod({})],
      'POST /api/validate': { error: 'browser not reachable' },
    })
    renderTab()
    await screen.findByText('SkyUI')
    await userEvent.click(screen.getByLabelText(/select SkyUI/))
    await userEvent.click(screen.getByRole('button', { name: 'Validate (1)' }))
    expect(await screen.findByText('browser not reachable')).toBeInTheDocument()
  })

  it('redownload success jumps to Progress tab', async () => {
    const go = vi.fn()
    mockLib({
      'GET /api/mods': [mod({})],
      'POST /api/redownload': { started: 1 },
    })
    renderTab(go)
    await screen.findByText('SkyUI')
    await userEvent.click(screen.getByLabelText(/select SkyUI/))
    await userEvent.click(screen.getByRole('button', { name: 'Redownload (1)' }))
    await waitFor(() => expect(go).toHaveBeenCalled())
  })

  it('refreshes when a download job transitions running→finished', async () => {
    const { calls } = mockLib({ 'GET /api/mods': [mod({})] })
    renderTab()
    await screen.findByText('SkyUI')
    const before = calls.filter((c) => c.path === '/api/mods').length

    const dl = { phase: 'downloading', files: [], error: null, running: true }
    act(() => FakeEventSource.last.emit({ dl, sort: { phase: 'idle', running: false, error: null } }))
    act(() =>
      FakeEventSource.last.emit({
        dl: { ...dl, phase: 'done', running: false },
        sort: { phase: 'idle', running: false, error: null },
      }),
    )
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/mods').length).toBe(before + 1))
  })

  it('deleted view: Delete becomes Purge and hits /api/purge', async () => {
    const { calls } = mockLib({
      'GET /api/mods': [mod({ file_id: 5, mod_name: 'GhostMod', file_name: 'ghost.7z', status: 'deleted' })],
      'POST /api/purge': { purged: 1, files_removed: 0 },
    })
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /Show deleted/ }))
    expect(await screen.findByText('GhostMod')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText(/select ghost.7z/))
    await userEvent.click(screen.getByRole('button', { name: 'Purge (1)' }))
    expect(await screen.findByText('Permanently purge 1 record(s)?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Purge' }))

    const p = calls.find((c) => c.path === '/api/purge')
    expect(p?.body).toEqual({ file_ids: [5] })
    expect(calls.some((c) => c.path === '/api/delete')).toBe(false)
    expect(await screen.findByText(/1 record\(s\) purged/)).toBeInTheDocument()
  })

  it('import from disk: starts the job, polls state, then reloads with adopted rows', async () => {
    let started = false
    mockLib({
      'GET /api/mods': () =>
        started ? [mod({}), mod({ file_id: 2, mod_name: 'LocalMod', file_name: 'localmod.7z' })] : [mod({})],
      'POST /api/import-local': () => {
        started = true
        return { started: true }
      },
      'GET /api/import-local-state': () => ({
        phase: started ? 'Adopted 1 file(s) (1 non-Nexus)' : 'idle',
        running: false,
        error: null,
      }),
    })
    renderTab()
    await screen.findByText('SkyUI')

    await userEvent.click(screen.getByRole('button', { name: 'Import from disk' }))
    expect(await screen.findByText('LocalMod')).toBeInTheDocument()
    expect(screen.getByText(/Adopted 1 file/)).toBeInTheDocument()
  })

  it('committed order disables delete + redownload and shows a banner', async () => {
    mockLib({
      'GET /api/mods': [mod({})],
      'GET /api/order/commit-state': { ...COMMIT_IDLE, committed: true },
    })
    renderTab()
    await screen.findByText('SkyUI')
    await userEvent.click(screen.getByLabelText(/select SkyUI/))

    expect(screen.getByRole('button', { name: 'Delete (1)' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redownload (1)' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Import from disk' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Validate (1)' })).toBeEnabled() // read-only, still allowed
    expect(screen.getByText(/committed to disk/i)).toBeInTheDocument()
  })
})
