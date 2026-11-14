import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: './.artifacts',
  globalSetup: './global-setup.mjs',
  use: {
    baseURL: 'http://127.0.0.1:8765/',
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/server.mjs 8765',
    url: 'http://127.0.0.1:8765/',
    reuseExistingServer: !process.env.CI,
    cwd: new URL('../..', import.meta.url).pathname,
  },
});
