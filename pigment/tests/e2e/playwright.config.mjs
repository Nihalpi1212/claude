import { defineConfig } from '@playwright/test';

// PIGMENT_E2E_PORT lets several test runs (or builders) share one checkout without port clashes.
const PORT = Number(process.env.PIGMENT_E2E_PORT || 8765);
const OUT = process.env.PIGMENT_E2E_OUT || './.artifacts';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: OUT,
  globalSetup: './global-setup.mjs',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node tests/e2e/server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    cwd: new URL('../..', import.meta.url).pathname,
  },
});
