const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.js',
  use: {
    baseURL: 'http://localhost:3001',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'PORT=3001 node server.js',
    url: 'http://localhost:3001',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
