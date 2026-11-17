const { defineConfig, devices } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Endpoint security blocks ~/Library/Application Support/Firefox, and Firefox
// before 153.6 hangs headless when it cannot read profiles.ini there.
const firefoxHome = path.join(os.tmpdir(), 'playwright-firefox-home');
fs.mkdirSync(firefoxHome, { recursive: true });
const firefoxEnv = { ...process.env, CFFIXED_USER_HOME: firefoxHome };

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: { env: firefoxEnv } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: [
    {
      command: 'node tests/support/static-server.js',
      port: 4173,
      reuseExistingServer: !process.env.CI
    }
  ]
});
