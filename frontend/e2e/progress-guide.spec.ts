import { test, expect } from '@playwright/test'

test.describe('Progress + Guide tabs', () => {
  test('all tabs render without console errors; SSE connects', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    await page.goto('/')
    for (const tab of ['Install Order', 'Collections', 'Import', 'Progress', 'Guide', 'Library']) {
      await page.getByRole('button', { name: tab }).click()
    }

    await page.getByRole('button', { name: 'Progress' }).click()
    await expect(page.getByRole('heading', { name: /idle|downloading|generating/ })).toBeVisible()
    await expect(page.locator('.stats')).toContainText('speed')

    // SSE stream reaches the page (readyState OPEN=1 on the EventSource)
    await expect
      .poll(async () =>
        page.evaluate(() => {
          // any frame already processed proves the stream; otherwise probe a fresh one
          return new Promise<number>((resolve) => {
            const es = new EventSource('/api/events')
            es.onopen = () => {
              es.close()
              resolve(1)
            }
            es.onerror = () => {
              es.close()
              resolve(0)
            }
          })
        }),
      )
      .toBe(1)

    await page.getByRole('button', { name: 'Guide' }).click()
    await expect(page.getByRole('heading', { name: 'Install Order' })).toBeVisible()

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([])
  })
})
