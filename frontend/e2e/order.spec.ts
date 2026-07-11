import { test, expect, type Page } from '@playwright/test'

const gotoOrder = async (page: Page) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Install Order' }).click()
  await expect(page.locator('.ordrow').first()).toBeVisible()
}

test.describe('Install Order tab', () => {
  test('renders ordered list with group badges', async ({ page }) => {
    await gotoOrder(page)
    expect(await page.locator('.ordrow').count()).toBeGreaterThan(0)
    await expect(page.locator('.ordrow .badge').first()).toBeVisible() // group badges
  })

  // Flaky: simulated mouse drag races dnd-kit's own CSS-transitioned live-reorder
  // preview and, right after globalSetup's build, the virtualizer's async row-height
  // settle. hover()+convergence-loop below cut the failure rate a lot but not to zero;
  // retried here rather than blocking CI on a harness timing race, not a product bug
  // (manual verification: the underlying drag/move logic is correct).
  test.describe('drag interaction (flaky)', () => {
    test.describe.configure({ retries: 2 })

    test('drag via handle persists after reload', async ({ page }) => {
      await gotoOrder(page)
      const rows = page.locator('.ordrow')
      if ((await rows.count()) < 3) test.skip()

      const nameOf = async (i: number) => (await rows.nth(i).locator('> div').nth(2).textContent())?.trim()
      const dragged = await nameOf(0)

      const handle = rows.nth(0).locator('.draghandle')
      const target = rows.nth(2)
      const moved = page.waitForResponse((r) => r.url().includes('/api/order/move'), { timeout: 10_000 })
      // hover() (not a manually-computed page.mouse.move(x, y)) re-measures the
      // handle immediately before moving the mouse there — the window's scroll
      // position can still be settling (offsetTop-driven scrollMargin, tanstack's
      // own scroll-anchor compensation) right after page load, and a coordinate
      // captured even a tick earlier can go stale, landing the click in empty
      // space with nothing under the pointer.
      await handle.hover()
      await page.mouse.down()
      const hb = (await handle.boundingBox())!
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 8) // pass the 4px activation constraint
      await page.waitForTimeout(150) // let dnd-kit activate + measure
      // dnd-kit's own live-reorder preview shifts rows as the drag crosses them
      // (by design — that's the reordering feedback), and that shift is itself
      // CSS-transitioned (dnd-kit default: 200ms), so "aim at the target's
      // current spot" is a moving target that also reacts to the mouse
      // arriving — a fixed N-step interpolation toward a stale endpoint can
      // land the drop a row off. Converge instead: jump to wherever the target
      // row currently sits, wait out the transition, and repeat until two
      // consecutive reads agree — the same feedback loop a real user's hand
      // performs by eye, just explicit.
      let prevY: number | null = null
      for (let i = 0; i < 20; i++) {
        const tb = (await target.boundingBox())!
        const endY = tb.y + tb.height / 2
        await page.mouse.move(hb.x + hb.width / 2, endY)
        await page.waitForTimeout(60)
        if (prevY !== null && Math.abs(endY - prevY) < 1) break
        prevY = endY
      }
      await page.waitForTimeout(300)
      await page.mouse.up()
      await moved

      await expect(page.locator('text=/moved .*to #/')).toBeVisible()
      await page.reload()
      await page.getByRole('button', { name: 'Install Order' }).click()
      await expect(page.locator('.ordrow').first()).toBeVisible()
      const names = await Promise.all([nameOf(0), nameOf(1), nameOf(2)])
      expect(names).toContain(dragged)
      expect(names[0]).not.toBe(dragged) // it actually moved down
    })
  })

  test('bulk lock via selection toolbar round-trips', async ({ page }) => {
    await gotoOrder(page)
    const rows = page.locator('.ordrow')
    await rows.nth(0).locator('> div').nth(2).click()
    await rows.nth(1).locator('> div').nth(2).click({ modifiers: ['Control'] })
    await expect(page.getByText('2 selected')).toBeVisible()

    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await expect(page.locator('.ordrow').nth(0).locator('.lockbtn.on')).toBeVisible()
    await expect(page.locator('.ordrow').nth(1).locator('.lockbtn.on')).toBeVisible()

    // selection survives the reload — Unlock straight away
    await expect(page.getByText('2 selected')).toBeVisible()
    // exact: a sortable row's accessible name can contain "Unlock" (mod names)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.locator('.ordrow').nth(0).locator('.lockbtn.on')).toHaveCount(0)
  })

  test('inline position edit moves a row', async ({ page }) => {
    await gotoOrder(page)
    const rows = page.locator('.ordrow')
    if ((await rows.count()) < 3) test.skip()
    const name = (await rows.nth(2).locator('> div').nth(2).textContent())?.trim()

    await rows.nth(2).locator('.posnum').click()
    // exact: the always-present bulk toolbar has "bulk move to position"
    await page.getByLabel('move to position', { exact: true }).fill('1')
    await page.getByLabel('move to position', { exact: true }).press('Enter')

    await expect(page.locator('text=/moved .*to #1/')).toBeVisible()
    await expect(rows.nth(0).locator('> div').nth(2)).toContainText(name || '')
  })

  test('row click selects; ctrl-click extends', async ({ page }) => {
    await gotoOrder(page)
    const rows = page.locator('.ordrow')
    await rows.nth(0).locator('> div').nth(2).click()
    await expect(page.getByText('1 selected')).toBeVisible()
    await rows.nth(1).locator('> div').nth(2).click({ modifiers: ['Control'] })
    await expect(page.getByText('2 selected')).toBeVisible()
    await page.getByRole('button', { name: 'Clear selection' }).click()
  })

  test('heuristic sort completes and logs to the Sort subtab', async ({ page }) => {
    await gotoOrder(page)
    await page.getByRole('button', { name: 'Sort (heuristic)' }).click()
    await expect(page.locator('text=/\\d+ mods sorted \\(last run\\)/')).toBeVisible({ timeout: 20_000 })
  })
})
