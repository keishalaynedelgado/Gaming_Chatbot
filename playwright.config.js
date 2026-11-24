'use strict';
// Playwright end-to-end tests: e2e/ (see e2e/README.md). The unit/integration
// suite with a mock AI is separate (`npm test`, test/run.js).
const { defineConfig, devices } = require('@playwright/test');

// 127.0.0.1, not localhost: on Windows "localhost" can resolve to ::1 and
// reach a different server listening on the same port over IPv6.
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const REPORT_DIR = 'playwright-report';

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  // Each test waits on a real AI build (minutes); the per-test limit is set
  // in the spec from E2E_GENERATION_TIMEOUT_MIN.
  timeout: 45 * 60 * 1000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  // One build at a time by default, so three parallel builds can't hit the
  // AI provider's rate limits; E2E_WORKERS=3 runs them side by side.
  workers: Number(process.env.E2E_WORKERS || 1),
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
    ['./e2e/support/summaryReporter.js', { outputFolder: REPORT_DIR }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  // The app's own start command; an already-running server is reused.
  webServer: {
    command: 'npm start',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: true,
    timeout: 120 * 1000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
