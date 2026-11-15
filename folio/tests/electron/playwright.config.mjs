// Playwright configuration for tests that launch the real Electron app (main process, preload,
// IPC, menus). Needs the Electron binary (npm ci without ELECTRON_SKIP_BINARY_DOWNLOAD) and, on
// Linux, a display (xvfb-run npx playwright test -c tests/electron/playwright.config.mjs).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: './.artifacts',
  globalSetup: '../e2e/global-setup.mjs',
});
