import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  timeout: 20000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:8766', headless: true },
  webServer: {
    command: 'node --import tsx test/web-fixture.ts',
    url: 'http://127.0.0.1:8766/api/state',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
