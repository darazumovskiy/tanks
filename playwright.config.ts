import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'packages/client/test/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
  },
});
