import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OrderTab } from './OrderTab'
import { EventsProvider } from '../../events/EventsProvider'
import { mockApi } from '../../test/mockApi'
import { FakeEventSource } from '../../test/FakeEventSource'
import { __resetPromptCache } from './PromptEditor'
import type { OrderMod } from '../../api/types'

let uninstall: () => void
beforeEach(() => {
  uninstall = FakeEventSource.install()
  __resetPromptCache()
})
afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const m = (over: Partial<OrderMod>): OrderMod => ({
  mod_id: 1,
  mod_name: 'SkyUI',
  mod_url: 'https://n/1',
  category: 'Interface',
  bucket: 3,
  locked: false,
  installed: false,
  mo2_state: null,
  source: null,
  separator_id: null,
  conflict_pin: false,
  pin_reason: null,
  file_type: null,
  flags: [],
  ...over,
})

const ORDER = {
  buckets: { '3': 'Interface', '5': 'Foundation' },
  mods: [
    m({ mod_id: 1, mod_name: 'SkyUI', bucket: 3 }),
    m({ mod_id: 2, mod_name: 'MoreHUD', bucket: 3, locked: true }),
    m({ mod_id: 3, mod_name: 'USSEP', bucket: 5, category: 'Patches', flags: ['CONFLICT:1'] }),
  ],
  notes: [],
}
const IDLE = { phase: 'idle', running: false, error: null }

// Separator taxonomy for the Change-group dropdown: one band present in the
// order (mod_count > 0), one empty, one structural header (excluded from targets).
const SEPARATORS = {
  separators: [
    { id: 100, name: 'CORE MODS', special_kind: 'header', collapsed: 0, mod_count: 0 },
    { id: 201, name: 'MENUS - HUD', special_kind: null, collapsed: 0, mod_count: 2 },
    { id: 102, name: 'CORE FIXES', special_kind: null, collapsed: 0, mod_count: 0 },
  ],
}

const routes = (extra: Record<string, unknown> = {}) => ({
  'GET /api/installorder': ORDER,
  'GET /api/sort-state': IDLE,
  'GET /api/enforce-state': IDLE,
  'GET /api/conflicts': { pairs: [], scanned: 0, total: 0 },
  'GET /api/requirements-missing': { missing: [] },
  'GET /api/sort-prompt': { prompt: 'sort {{MODS}} into {{BUCKETS}}', default: 'default prompt' },
  ...extra,
})

const renderTab = () =>
  render(
    <EventsProvider>
      <OrderTab />
    </EventsProvider>,
  )

// Toolbar buttons share labels with subtab nav buttons — disambiguate by class.
const toolbarBtn = (name: string | RegExp) =>
  screen.getAllByRole('button', { name }).find((b) => b.className.includes('btn'))!
const subtabBtn = (name: string | RegExp) =>
  screen.getAllByRole('button', { name }).find((b) => !b.className.includes('btn'))!

describe('OrderTab list', () => {
  it('renders rows in a flat list (no group separators), with badges', async () => {
    mockApi(routes())
    renderTab()
    expect(await screen.findByText('SkyUI')).toBeInTheDocument()
    // no run/group header rows anymore
    expect(screen.queryByText('2 mods · #1–2')).not.toBeInTheDocument()
    // conflict badge resolves target name
    expect(screen.getByText('CONFLICT ↔ SkyUI')).toBeInTheDocument()
    // locked row shows pinned lock
    expect(screen.getByTitle(/pinned — sorts will not move/)).toBeInTheDocument()
  })

  it('group filter re-renders from cache with zero refetches', async () => {
    const { calls } = mockApi(routes())
    renderTab()
    await screen.findByText('SkyUI')
    const fetches = calls.filter((c) => c.path === '/api/installorder').length

    await userEvent.selectOptions(screen.getByLabelText('filter group'), '5')
    expect(screen.queryByText('SkyUI')).not.toBeInTheDocument()
    expect(screen.getByText('USSEP')).toBeInTheDocument()
    expect(screen.getByText('(1 of 3 shown)')).toBeInTheDocument()
    expect(calls.filter((c) => c.path === '/api/installorder').length).toBe(fetches)
  })
})

describe('OrderTab highlight + locked toggles', () => {
  // chip and subtab/toolbar share some labels — pick the .chip variant
  const chipBtn = (name: string | RegExp) =>
    screen.getAllByRole('button', { name }).find((b) => b.className.includes('chip'))!

  it('toggling a highlight chip off hides its badge, on re-shows — no refetch', async () => {
    const { calls } = mockApi(routes())
    renderTab()
    await screen.findByText('SkyUI')
    expect(screen.getByText('CONFLICT ↔ SkyUI')).toBeInTheDocument()
    // one mod (USSEP) carries a CONFLICT tag → chip shows (1)
    expect(chipBtn(/Conflicts/)).toHaveTextContent('Conflicts (1)')
    const fetches = calls.filter((c) => c.path === '/api/installorder').length

    await userEvent.click(chipBtn(/Conflicts/))
    expect(screen.queryByText('CONFLICT ↔ SkyUI')).not.toBeInTheDocument()
    await userEvent.click(chipBtn(/Conflicts/))
    expect(screen.getByText('CONFLICT ↔ SkyUI')).toBeInTheDocument()
    // pure display toggle — never re-hits the backend
    expect(calls.filter((c) => c.path === '/api/installorder').length).toBe(fetches)
  })

  it('locked toggle hides locked rows; others keep their global position', async () => {
    mockApi(routes())
    renderTab()
    await screen.findByText('SkyUI')
    // MoreHUD is the locked row in the fixture
    expect(screen.getByText('MoreHUD')).toBeInTheDocument()

    await userEvent.click(chipBtn(/Locked/))
    expect(screen.queryByText('MoreHUD')).not.toBeInTheDocument()
    expect(screen.getByText('SkyUI')).toBeInTheDocument()
    // USSEP keeps its real rank #3 even though the locked row above is hidden
    expect(screen.getByText('USSEP').closest('.ordrow')).toHaveTextContent('3')
    expect(screen.getByText('(2 of 3 shown)')).toBeInTheDocument()
  })
})

describe('OrderTab selection + bulk actions', () => {
  it('checkbox selection: clicks accumulate, re-click removes, shift ranges, outside-click clears', async () => {
    mockApi(routes())
    renderTab()
    await screen.findByText('SkyUI')
    const user = userEvent.setup() // one session so held modifiers apply to clicks

    // plain click selects; a second row click accumulates (does NOT replace)
    await user.click(screen.getByText('SkyUI'))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByText('MoreHUD'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    expect(screen.getByText('SkyUI').closest('.ordrow')).toHaveClass('r-sel')
    expect(screen.getByText('MoreHUD').closest('.ordrow')).toHaveClass('r-sel')

    // re-clicking a selected row removes it (checkbox toggle)
    await user.click(screen.getByText('SkyUI'))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(screen.getByText('SkyUI').closest('.ordrow')).not.toHaveClass('r-sel')

    // shift-click ranges from the last-clicked anchor (SkyUI, idx0) to USSEP (idx2)
    await user.keyboard('{Shift>}')
    await user.click(screen.getByText('USSEP'))
    await user.keyboard('{/Shift}')
    expect(screen.getByText('3 selected')).toBeInTheDocument()

    // clicking empty space (a header cell) clears the whole selection
    await user.click(screen.getByRole('columnheader', { name: 'Mod' }))
    expect(screen.queryByRole('toolbar', { name: 'bulk actions' })).not.toBeInTheDocument()
  })

  it('clicking a link or lock inside a row does not change the selection', async () => {
    mockApi(routes({ 'POST /api/order/lock': { mod_ids: [1], locked: true } }))
    renderTab()
    await screen.findByText('SkyUI')
    await userEvent.click(screen.getByText('SkyUI'))
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // lock button click must not collapse the selection to that row
    await userEvent.click(screen.getAllByTitle('pin at this position')[0])
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('bulk lock: select two rows → Lock posts mod_ids list', async () => {
    const { calls } = mockApi(routes({ 'POST /api/order/lock': { mod_ids: [1, 2], locked: true } }))
    renderTab()
    await screen.findByText('SkyUI')
    const user = userEvent.setup()

    await user.click(screen.getByText('SkyUI'))
    await user.keyboard('{Control>}')
    await user.click(screen.getByText('MoreHUD'))
    await user.keyboard('{/Control}')
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Lock' }))
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/order/lock')?.body).toEqual({ mod_ids: [1, 2], locked: true }),
    )
  })

  it('bulk delete: confirm dialog → POST mod_ids → message + selection cleared', async () => {
    const { calls } = mockApi(routes({ 'POST /api/delete': { deleted: 2, files_removed: 2 } }))
    renderTab()
    await screen.findByText('SkyUI')
    const user = userEvent.setup()

    await user.click(screen.getByText('SkyUI'))
    await user.click(screen.getByText('MoreHUD'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete (2)' }))
    expect(await screen.findByText('Delete 2 mod(s)?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/delete')?.body).toEqual({ mod_ids: [1, 2] }),
    )
    expect(await screen.findByText('2 marked deleted · 2 file(s) removed from disk')).toBeInTheDocument()
    expect(screen.queryByRole('toolbar', { name: 'bulk actions' })).not.toBeInTheDocument()
  })

  it('bulk move to an exact position posts that position for the selection', async () => {
    const { calls } = mockApi(routes({ 'POST /api/order/move': { moved: [2, 3], position: 1 } }))
    renderTab()
    await screen.findByText('SkyUI')
    const user = userEvent.setup()
    await user.click(screen.getByText('MoreHUD'))
    await user.keyboard('{Control>}')
    await user.click(screen.getByText('USSEP'))
    await user.keyboard('{/Control}')
    await user.type(screen.getByLabelText('bulk move to position'), '1')
    await user.click(toolbarBtn('Move'))
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/order/move')?.body).toEqual({ mod_ids: [2, 3], position: 1, separator_id: null }),
    )
  })

  it('change separator moves the selection to the END of the chosen band', async () => {
    const { calls } = mockApi(
      routes({ 'GET /api/separators': SEPARATORS, 'POST /api/order/move': { moved: [3], position: 4 } }),
    )
    renderTab()
    await screen.findByText('SkyUI')
    await userEvent.click(screen.getByText('USSEP'))
    // pick band 201; the frontend sends position = list length + 1 (clamped to
    // the tail server-side) with the target separator id
    await userEvent.selectOptions(screen.getByLabelText('change separator'), '201')
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/order/move')?.body).toEqual({ mod_ids: [3], position: 4, separator_id: 201 }),
    )
  })

  it('change group moves the selection to the end of that bucket run', async () => {
    const { calls } = mockApi(routes({ 'POST /api/order/move': { moved: [3], position: 3 } }))
    renderTab()
    await screen.findByText('SkyUI')
    await userEvent.click(screen.getByText('USSEP'))
    // Interface (bucket 3) last remaining mod (MoreHUD) is index 1 once USSEP is
    // excluded; end-of-group = position 3, on the group (bucket) axis (no band)
    await userEvent.selectOptions(screen.getByLabelText('change group'), '3')
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/order/move')?.body).toEqual({ mod_ids: [3], position: 3, separator_id: null }),
    )
  })

  it('per-row lock button toggles one mod without selection', async () => {
    const { calls } = mockApi(routes({ 'POST /api/order/lock': { mod_ids: [2], locked: false } }))
    renderTab()
    await screen.findByText('SkyUI')
    await userEvent.click(screen.getByTitle(/pinned — sorts will not move/))
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/order/lock')?.body).toEqual({ mod_ids: [2], locked: false }),
    )
  })

  it('inline position edit commits on Enter', async () => {
    const { calls } = mockApi(routes({ 'POST /api/order/move': { moved: [3], position: 1 } }))
    renderTab()
    await screen.findByText('USSEP')
    await userEvent.click(screen.getAllByTitle('click to type an exact position')[2])
    const box = screen.getByLabelText('move to position')
    await userEvent.clear(box)
    await userEvent.type(box, '1{Enter}')
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/order/move')?.body).toEqual({ mod_ids: [3], position: 1, separator_id: null }),
    )
  })

  it('refining (sort-state running) disables locks and bulk actions', async () => {
    mockApi(routes({ 'GET /api/sort-state': { phase: 'refining', running: true, error: null } }))
    renderTab()
    await screen.findByText('SkyUI')
    const locks = screen.getAllByTitle(/pin at this position|pinned/)
    for (const b of locks) expect(b).toBeDisabled()
    await userEvent.click(screen.getByText('SkyUI'))
    expect(screen.getByRole('button', { name: 'Lock' })).toBeDisabled()
  })
})

describe('OrderTab sort machinery', () => {
  it('heuristic sort posts llm:false + model, logs result in Sort subtab', async () => {
    const { calls } = mockApi(routes({ 'POST /api/sort': { sorted: 3, llm: false } }))
    renderTab()
    await screen.findByText('SkyUI')
    expect(screen.getByText('Not run yet this session.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Sort (heuristic)' }))
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/sort')?.body).toEqual({ llm: false, model: 'haiku' }),
    )
    expect(await screen.findByText('3 mods sorted into bands (last run)')).toBeInTheDocument()
  })

  it('refine enters refining mode: button becomes Force Stop, stop posts sort-stop', async () => {
    let running = false
    const { calls } = mockApi(
      routes({
        'POST /api/sort': () => {
          running = true
          return { started: true }
        },
        'POST /api/sort-stop': { stopped: true },
        'GET /api/sort-state': () => ({
          phase: running ? 'refining with claude' : 'idle',
          running,
          error: null,
          job: 'bulk',
        }),
      }),
    )
    renderTab()
    await screen.findByText('SkyUI')

    await userEvent.click(toolbarBtn('Refine with Claude'))
    const stop = await screen.findByRole('button', { name: 'Force Stop Claude' })
    expect(calls.find((c) => c.path === '/api/sort')?.body).toEqual({ llm: true, model: 'haiku' })

    await userEvent.click(stop)
    await waitFor(() => expect(calls.some((c) => c.path === '/api/sort-stop')).toBe(true))
  })

  it('refine uncertain posts model and enters refining', async () => {
    let running = false
    const { calls } = mockApi(
      routes({
        'POST /api/sort-desc': () => {
          running = true
          return { started: true }
        },
        'GET /api/sort-state': () => ({ phase: running ? 'checking' : 'idle', running, error: null, job: 'desc' }),
      }),
    )
    renderTab()
    await screen.findByText('SkyUI')
    await userEvent.selectOptions(screen.getByLabelText('claude model'), 'opus')
    await userEvent.click(toolbarBtn('Refine uncertain'))
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/sort-desc')?.body).toEqual({ model: 'opus' }),
    )
    expect(await screen.findByRole('button', { name: 'Force Stop Claude' })).toBeInTheDocument()
  })

  it('SSE sort.running auto-enters refining mode', async () => {
    let running = false
    mockApi(
      routes({
        'GET /api/sort-state': () => ({ phase: running ? 'refining' : 'idle', running, error: null, job: 'bulk' }),
      }),
    )
    renderTab()
    await screen.findByText('SkyUI')
    expect(toolbarBtn('Refine with Claude')).toBeInTheDocument()

    running = true // a refine started elsewhere; SSE reports it mid-session
    act(() =>
      FakeEventSource.last.emit({
        dl: { phase: 'idle', files: [], error: null, running: false },
        sort: { phase: 'refining', running: true, error: null },
      }),
    )
    expect(await screen.findByRole('button', { name: 'Force Stop Claude' })).toBeInTheDocument()
  })

  it('drift check marks wrong rows red with expected-group tooltip', async () => {
    mockApi(routes({ 'GET /api/order/check': { mismatches: [{ mod_id: 3, expected: 3 }] } }))
    renderTab()
    await screen.findByText('USSEP')
    // title-disambiguated: a subtab button shares the same label
    await userEvent.click(screen.getByTitle(/Flags mods whose current group disagrees/))
    await userEvent.click(subtabBtn(/Check for drift/)) // message lives in its panel

    expect(await screen.findByText(/1 mod\(s\) sit in a different group/)).toBeInTheDocument()
    await waitFor(() => {
      // the drift panel now also lists the mod by name — pick the table row
      const row = screen
        .getAllByText('USSEP')
        .map((el) => el.closest('.ordrow'))
        .find(Boolean)
      expect(row).toHaveClass('r-wrong')
      expect(row?.getAttribute('title')).toMatch(/Sort\/Refine expected "Interface"/)
    })
    expect(screen.getByText('WRONG SPOT → Interface')).toBeInTheDocument()
    // drifted-mods list names the mod with a jump link and both groups
    expect(screen.getByText(/Drifted mods · 1/)).toBeInTheDocument()
    expect(
      screen.getByText((_, el) => el?.tagName === 'LI' && /now in “Foundation”, sorter expected “Interface”/.test(el.textContent || '')),
    ).toBeInTheDocument()
  })

  it('jump link scrolls to the mod row; hidden-by-filter miss shows a message', async () => {
    mockApi(routes({ 'GET /api/order/check': { mismatches: [{ mod_id: 3, expected: 3 }] } }))
    const scrolls: Element[] = []
    Element.prototype.scrollIntoView = function () {
      scrolls.push(this)
    }
    renderTab()
    await screen.findByText('USSEP')
    await userEvent.click(screen.getByTitle(/Flags mods whose current group disagrees/))
    await userEvent.click(subtabBtn(/Check for drift/))
    await screen.findByText(/Drifted mods · 1/)

    // virtualized: the target row may not be mounted yet when the jump
    // lands, so the retry-until-mounted loop settles a frame or two later
    await userEvent.click(screen.getByTitle('jump to USSEP in the list below'))
    await waitFor(() => expect(scrolls[0]).toHaveAttribute('data-mid', '3'))
    expect(scrolls[0]).toHaveClass('row-flash')

    // filter USSEP's row out → the jump can't land, message explains why
    await userEvent.selectOptions(screen.getByLabelText('filter group'), '3')
    await userEvent.click(screen.getByTitle('jump to USSEP in the list below'))
    await waitFor(() => expect(screen.getByText(/mod 3 is hidden by the current filter/)).toBeInTheDocument())
    expect(scrolls).toHaveLength(1)
  })

  it('scan archives starts the job, polls scan-state, then reloads conflicts', async () => {
    let started = false
    mockApi(
      routes({
        'POST /api/scan-conflicts': () => {
          started = true
          return { started: true }
        },
        // first poll after start reports done — poller stops and reloads
        'GET /api/scan-state': () => ({ phase: started ? 'done' : 'idle', running: false, error: null }),
        'GET /api/conflicts': () =>
          started
            ? {
                pairs: [
                  {
                    a: { mod_id: 1, mod_name: 'SkyUI' },
                    b: { mod_id: 2, mod_name: 'MoreHUD' },
                    paths: ['f.dds'],
                    expected: false,
                  },
                ],
                scanned: 3,
                total: 3,
              }
            : { pairs: [], scanned: 0, total: 0 },
      }),
    )
    renderTab()
    expect(await screen.findByText('SkyUI')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Scan archives' }))
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'LI' && /SkyUI \(1\) vs MoreHUD \(2\): 1 shared file/.test(el.textContent || ''),
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/3\/3 archives scanned/)).toBeInTheDocument()
  })
})

describe('OrderTab commit to disk', () => {
  it('committed state freezes reordering but keeps filters + analysis live', async () => {
    mockApi(routes({ 'GET /api/installorder': { ...ORDER, committed: true } }))
    renderTab()
    await screen.findByText('SkyUI')

    // reordering surfaces frozen
    expect(toolbarBtn('Sort (heuristic)')).toBeDisabled()
    expect(toolbarBtn(/Refine with Claude/)).toBeDisabled()
    screen.getAllByTitle(/pin at this position|pinned/).forEach((b) => expect(b).toBeDisabled())

    // escape hatch + read-only tools stay enabled
    expect(screen.getByRole('button', { name: /Committed to disk — click to revert/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Scan archives' })).toBeEnabled()
    expect(screen.getByLabelText('filter category')).toBeEnabled()
  })

  it('commit: confirm → POST commit → poll done → shows committed + freezes', async () => {
    let committed = false
    const { calls } = mockApi(
      routes({
        'GET /api/installorder': () => ({ ...ORDER, committed }),
        'POST /api/order/commit': () => {
          committed = true
          return { started: true }
        },
        'GET /api/order/commit-state': () => ({
          phase: committed ? 'Committed 3 file(s)' : 'idle',
          running: false,
          error: null,
          committed,
        }),
      }),
    )
    renderTab()
    await screen.findByText('SkyUI')

    await userEvent.click(screen.getByRole('button', { name: 'Commit order to disk' }))
    // confirm dialog's Commit button (class btn, not the toolbar toggle)
    await userEvent.click(await screen.findByRole('button', { name: 'Commit' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Committed to disk — click to revert/ })).toBeInTheDocument(),
    )
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/order/commit')).toBe(true)
    expect(toolbarBtn('Sort (heuristic)')).toBeDisabled()
  })

  it('commit: a failing commit-state poll clears the overlay and shows the error', async () => {
    mockApi(
      routes({
        'POST /api/order/commit': { started: true },
        // stale/broken backend: state route errors — must not hang the overlay
        'GET /api/order/commit-state': { __status: 404, error: 'Not Found' },
      }),
    )
    renderTab()
    await screen.findByText('SkyUI')

    await userEvent.click(screen.getByRole('button', { name: 'Commit order to disk' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Commit' }))

    // overlay gone, error surfaced
    await waitFor(() => expect(screen.getByText(/Commit failed/)).toBeInTheDocument())
    expect(screen.queryByText(/do not close this tab/i)).not.toBeInTheDocument()
  })
})

describe('PromptEditor', () => {
  it('loads prompt once, save posts content, reset posts empty string', async () => {
    const { calls } = mockApi(routes({ 'POST /api/sort-prompt': { saved: true } }))
    renderTab()
    await screen.findByText('SkyUI')

    const box = await screen.findByLabelText('claude prompt')
    await waitFor(() => expect(box).toHaveValue('sort {{MODS}} into {{BUCKETS}}'))

    await userEvent.click(screen.getByRole('button', { name: 'Save prompt' }))
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/sort-prompt' && c.method === 'POST')?.body).toEqual({
        prompt: 'sort {{MODS}} into {{BUCKETS}}',
      }),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    await waitFor(() => expect(box).toHaveValue('default prompt'))
    const posts = calls.filter((c) => c.path === '/api/sort-prompt' && c.method === 'POST')
    expect(posts.at(-1)?.body).toEqual({ prompt: '' })
  })
})
