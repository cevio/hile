import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  testMatch: 'demo.e2e.test.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3200',
    browserName: 'chromium',
    launchOptions: {
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    trace: 'retain-on-failure',
  },
});
