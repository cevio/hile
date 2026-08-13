import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  testMatch: process.env.RSC_DEV_E2E ? 'development.e2e.test.ts' : 'demo.e2e.test.ts',
  timeout: process.env.RSC_DEV_E2E ? 60_000 : 30_000,
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
