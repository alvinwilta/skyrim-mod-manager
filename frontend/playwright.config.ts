import { defineConfig } from '@playwright/test'

// E2E per the safe-live-test pattern: globalSetup builds the frontend, copies
// mods.db into e2e/.tmp/, and spawns a throwaway backend on 7799 with
// MODMAN_DB_PATH + MODMAN_EXTRA_ORIGINS; teardown kills it and asserts the
// real mods.db was untouched. Never targets the live server on 7788.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  workers: 1, // one shared backend + sqlite copy — keep tests serialized
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:7799',
    // system Chromium (Arch) — avoids the playwright browser download
    launchOptions: { executablePath: process.env.MODMAN_CHROMIUM ?? '/usr/bin/chromium' },
  },
})
