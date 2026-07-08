import { test, expect } from '@playwright/test'

test.describe('Collections tab', () => {
  test('cards render; expand lazy-loads mods; enable toggle round-trips', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Collections' }).click()

    const cards = page.locator('.grp')
    const emptyMsg = page.getByText(/No collections imported yet/)
    await expect(cards.first().or(emptyMsg)).toBeVisible()
    if (await emptyMsg.isVisible()) test.skip() // db copy has no collections

    // expand → mods table loads in install order (title = first direct span in h2)
    const title = cards.first().locator('h2 > span').first()
    await title.click()
    await expect(cards.first().locator('table, p.dim').first()).toBeVisible()

    // enable checkbox round-trip (flip, reload, verify persisted, flip back)
    const cb = cards.first().locator('input[type=checkbox]').first()
    const before = await cb.isChecked()
    await cb.click()
    await page.reload()
    await page.getByRole('button', { name: 'Collections' }).click()
    const cbAfter = page.locator('.grp').first().locator('input[type=checkbox]').first()
    await expect(cbAfter).toBeVisible()
    expect(await cbAfter.isChecked()).toBe(!before)
    await cbAfter.click() // restore
    expect(await cbAfter.isChecked()).toBe(before)
  })
})
