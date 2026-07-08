import { test, expect } from '@playwright/test'

test.describe('Library tab', () => {
  test('loads rows, search narrows, clear restores', async ({ page }) => {
    await page.goto('/')
    const search = page.getByPlaceholder(/Search name/)
    await expect(search).toBeVisible()

    await expect(page.locator('tbody tr').first()).toBeVisible() // data loaded
    const count = page.locator('text=/^\\d+ files/').first()
    const initial = parseInt((await count.textContent()) || '0', 10)
    expect(initial).toBeGreaterThan(0) // real db copy has mods

    await search.fill('zzzzqqqqxxxx-no-such-mod')
    await expect(page.locator('text=/^0 files/')).toBeVisible()

    await search.fill('')
    await expect(page.locator(`text=/^${initial} files/`)).toBeVisible()
  })

  test('shift-click range selection enables bulk buttons with counts', async ({ page }) => {
    await page.goto('/')
    const boxes = page.locator('tbody input[type=checkbox]')
    await expect(boxes.first()).toBeVisible()
    const n = Math.min(await boxes.count(), 3)
    await boxes.nth(0).click()
    if (n > 1) await boxes.nth(n - 1).click({ modifiers: ['Shift'] })

    await expect(page.getByRole('button', { name: `Validate (${n})` })).toBeEnabled()
    await expect(page.getByRole('button', { name: `Delete (${n})` })).toBeEnabled()
  })

  test('show/hide deleted toggle flips', async ({ page }) => {
    await page.goto('/')
    const toggle = page.getByRole('button', { name: /Show deleted/ })
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(page.getByRole('button', { name: 'Hide deleted' })).toBeVisible()
    await page.getByRole('button', { name: 'Hide deleted' }).click()
    await expect(page.getByRole('button', { name: /Show deleted/ })).toBeVisible()
  })
})
