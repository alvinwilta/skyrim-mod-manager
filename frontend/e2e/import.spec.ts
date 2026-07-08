import { test, expect } from '@playwright/test'

// Deliberately no real Nexus fetch/download here — network- and login-dependent.
test.describe('Import tab', () => {
  test('invalid JSON shows inline error without a request', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Import' }).click()
    await page.locator('textarea').fill('not json at all')
    await page.getByRole('button', { name: 'Diff against DB' }).click()
    await expect(page.getByText('invalid JSON')).toBeVisible()
  })

  test('empty URL fetch shows hint', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Import' }).click()
    await page.getByRole('button', { name: 'Fetch from Nexus' }).click()
    await expect(page.getByText('paste a collection url first')).toBeVisible()
  })
})
