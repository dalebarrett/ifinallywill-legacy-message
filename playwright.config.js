const { defineConfig } = require('@playwright/test');
require('dotenv').config();

// The local .env sets SITE_BASIC_USER/PASS (pre-launch gate), so both the
// webServer health-check URL and the browser context carry those credentials.
const USER = process.env.SITE_BASIC_USER || '';
const PASS = process.env.SITE_BASIC_PASS || '';
const gateAuth = USER ? `${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@` : '';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 45000,
  use: {
    baseURL: 'http://localhost:3001',
    httpCredentials: USER ? { username: USER, password: PASS } : undefined,
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'PORT=3001 node server.js',
    url: `http://${gateAuth}localhost:3001/i18n.js`,
    reuseExistingServer: true,
    timeout: 20000,
  },
});
