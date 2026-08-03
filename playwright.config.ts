import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:7779',
    headless: true,
  },
  webServer: {
    command: 'pnpm --filter @openryoko/web dev --hostname 127.0.0.1 --port 7779',
    url: 'http://localhost:7779/settings/topology',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
