import { test, expect, type Page } from '@playwright/test'

const gotoOrder = async (page: Page) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Install Order' }).click()
  await expect(page.locator('tr.ordrow').first()).toBeVisible()
}

test.describe('Install Order tab', () => {
  test('renders grouped list with badges and run headers', async ({ page }) => {
    await gotoOrder(page)
    expect(await page.locator('tr.ordrow').count()).toBeGreaterThan(0)
    expect(await page.locator('tr.runhead').count()).toBeGreaterThan(0)
    await expect(page.locator('tr.ordrow .badge').first()).toBeVisible() // group badges
  })

  test('drag via handle persists after reload', async ({ page }) => {
    await gotoOrder(page)
    const rows = page.locator('tr.ordrow')
    if ((await rows.count()) < 3) test.skip()

    const nameOf = async (i: number) => (await rows.nth(i).locator('td').nth(2).textContent())?.trim()
    const dragged = await nameOf(0)

    const handle = rows.nth(0).locator('.draghandle')
    const target = rows.nth(2)
    // raw page.mouse needs the rows inside the viewport (no auto-scroll)
    await handle.scrollIntoViewIfNeeded()
    const hb = (await handle.boundingBox())!
    const tb = (await target.boundingBox())!
    const moved = page.waitForResponse((r) => r.url().includes('/api/order/move'), { timeout: 10_000 })
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 8) // pass the 4px activation constraint
    await page.waitForTimeout(150) // let dnd-kit activate + measure
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + (((tb.y + tb.height / 2) - (hb.y + hb.height / 2)) * i) / 12)
    }
    await page.waitForTimeout(150)
    await page.mouse.up()
    await moved

    await expect(page.locator('text=/moved .*to #/')).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Install Order' }).click()
    await expect(page.locator('tr.ordrow').first()).toBeVisible()
    const names = await Promise.all([nameOf(0), nameOf(1), nameOf(2)])
    expect(names).toContain(dragged)
    expect(names[0]).not.toBe(dragged) // it actually moved down
  })

  test('bulk lock via selection toolbar round-trips', async ({ page }) => {
    await gotoOrder(page)
    const rows = page.locator('tr.ordrow')
    await rows.nth(0).locator('td').nth(2).click()
    await rows.nth(1).locator('td').nth(2).click({ modifiers: ['Control'] })
    await expect(page.getByText('2 selected')).toBeVisible()

    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await expect(page.locator('tr.ordrow').nth(0).locator('.lockbtn.on')).toBeVisible()
    await expect(page.locator('tr.ordrow').nth(1).locator('.lockbtn.on')).toBeVisible()

    // selection survives the reload — Unlock straight away
    await expect(page.getByText('2 selected')).toBeVisible()
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.locator('tr.ordrow').nth(0).locator('.lockbtn.on')).toHaveCount(0)
  })

  test('inline position edit moves a row', async ({ page }) => {
    await gotoOrder(page)
    const rows = page.locator('tr.ordrow')
    if ((await rows.count()) < 3) test.skip()
    const name = (await rows.nth(2).locator('td').nth(2).textContent())?.trim()

    await rows.nth(2).locator('.posnum').click()
    // exact: the always-present bulk toolbar has "bulk move to position"
    await page.getByLabel('move to position', { exact: true }).fill('1')
    await page.getByLabel('move to position', { exact: true }).press('Enter')

    await expect(page.locator('text=/moved .*to #1/')).toBeVisible()
    await expect(rows.nth(0).locator('td').nth(2)).toContainText(name || '')
  })

  test('marquee box-select: drag across rows selects them', async ({ page }) => {
    await gotoOrder(page)
    const rows = page.locator('tr.ordrow')
    if ((await rows.count()) < 3) test.skip()
    await rows.nth(0).scrollIntoViewIfNeeded()

    // start on non-interactive space (Mod name cell) of row 0, drag to row 2
    const startCell = rows.nth(0).locator('td').nth(2)
    const endCell = rows.nth(2).locator('td').nth(2)
    const sb = (await startCell.boundingBox())!
    const eb = (await endCell.boundingBox())!
    await page.mouse.move(sb.x + sb.width * 0.7, sb.y + 2)
    await page.mouse.down()
    await page.mouse.move(sb.x + sb.width * 0.7, eb.y + eb.height - 2, { steps: 10 })
    await expect(page.locator('.marquee')).toBeVisible()
    await page.mouse.up()

    await expect(page.getByText('3 selected')).toBeVisible()
    await page.getByRole('button', { name: 'Clear selection' }).click()
  })

  test('row click selects; ctrl-click extends', async ({ page }) => {
    await gotoOrder(page)
    const rows = page.locator('tr.ordrow')
    await rows.nth(0).locator('td').nth(2).click()
    await expect(page.getByText('1 selected')).toBeVisible()
    await rows.nth(1).locator('td').nth(2).click({ modifiers: ['Control'] })
    await expect(page.getByText('2 selected')).toBeVisible()
    await page.getByRole('button', { name: 'Clear selection' }).click()
  })

  test('heuristic sort completes and logs to the Sort subtab', async ({ page }) => {
    await gotoOrder(page)
    await page.getByRole('button', { name: 'Sort (heuristic)' }).click()
    await expect(page.locator('text=/\\d+ mods sorted \\(last run\\)/')).toBeVisible({ timeout: 20_000 })
  })
})
