import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(existsSync(chromiumPath) ? { executablePath: chromiumPath } : {}),
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/api/health',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
