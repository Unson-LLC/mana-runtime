import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'story-lightsail-deploy-workflow-*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [
    ['line'],
    ['json', { outputFile: 'test-results/deploy-playwright.json' }],
  ],
})
