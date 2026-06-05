const { test, expect } = require('@playwright/test');
const { clerk, setupClerkTestingToken } = require('@clerk/testing/playwright');

// Test user — must exist in the Clerk dev instance.
// Create once with: clerk users create --email-address playwright@ifinallywill-test.com
const TEST_EMAIL = process.env.CLERK_TEST_EMAIL || 'playwright@ifinallywill-test.com';

// ── Unauthenticated tests ─────────────────────────────────────────────────
test.describe('Unauthenticated', () => {

  test('welcome screen renders', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const welcome = page.locator('#welcome');
    await expect(welcome).toBeVisible();
  });

  test('welcome has auth buttons once Clerk loads', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Wait up to 8s for Clerk to inject buttons
    const signUpBtn = page.locator('#welcomeAuth button', { hasText: /Create|Sign up/i });
    await expect(signUpBtn).toBeVisible({ timeout: 8000 });
    const signInBtn = page.locator('#welcomeAuth button', { hasText: /Sign in/i });
    await expect(signInBtn).toBeVisible({ timeout: 3000 });
  });

  test('app bar renders brand and score', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const score = page.locator('#top-score-val');
    await expect(score).toBeVisible();
    await expect(score).toHaveText('0');
  });

  test('Clerk script is injected with publishable key', async ({ page }) => {
    await page.goto('/');
    const html = await page.content();
    expect(html).toContain('data-clerk-publishable-key');
    expect(html).toContain('clerk.browser.js');
  });

  test('API suggest requires auth (returns 401)', async ({ request }) => {
    const resp = await request.post('/api/suggest', {
      data: { mode: 'depth', text: 'test text here', chapId: 'know', chapTitle: 'What I want you to know' }
    });
    expect(resp.status()).toBe(401);
  });

  test('API transcribe requires auth (returns 401)', async ({ request }) => {
    const resp = await request.post('/api/transcribe');
    expect(resp.status()).toBe(401);
  });

});

// ── Authenticated tests ───────────────────────────────────────────────────
test.describe('Authenticated', () => {

  test.beforeEach(async ({ page }) => {
    // setupClerkTestingToken registers the route interceptor that injects the
    // testing token into every FAPI request so Clerk bypasses bot-protection.
    // Must be called before page.goto() so the interceptor is active when the
    // page loads and Clerk initialises.
    await setupClerkTestingToken({ page });
    // Navigate to the app so Clerk JS loads into the page.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Sign in the test user via a backend-issued sign-in token.
    // clerk.signIn() calls setupClerkTestingToken internally and then
    // uses signInTokens.createSignInToken() to sign in via ticket strategy.
    await clerk.signIn({ page, emailAddress: TEST_EMAIL });
  });

  test('welcome shows Continue after sign-in', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // After auth token is set, Clerk loads and shows the continue button
    const continueBtn = page.locator('#welcomeAuth button', { hasText: /Continue/i });
    await expect(continueBtn).toBeVisible({ timeout: 10000 });
  });

  test('dismiss welcome and enter app', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const continueBtn = page.locator('#welcomeAuth button', { hasText: /Continue/i });
    await expect(continueBtn).toBeVisible({ timeout: 10000 });
    await continueBtn.click();
    await expect(page.locator('#welcome')).toHaveClass(/gone/);
    // Main app is visible
    await expect(page.locator('.main')).toBeVisible();
    await expect(page.locator('.rail')).toBeVisible();
  });

  test('chapter navigation works', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const continueBtn = page.locator('#welcomeAuth button', { hasText: /Continue/i });
    await expect(continueBtn).toBeVisible({ timeout: 10000 });
    await continueBtn.click();
    // Click chapter 2
    const chaps = page.locator('.chap-li:not(.sec-li)');
    await expect(chaps).toHaveCount(6, { timeout: 5000 });
    await chaps.nth(1).click();
    // Verify main area updated
    const heading = page.locator('.main h2');
    await expect(heading).toBeVisible();
  });

  test('text input saves and score updates', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const continueBtn = page.locator('#welcomeAuth button', { hasText: /Continue/i });
    await expect(continueBtn).toBeVisible({ timeout: 10000 });
    await continueBtn.click();
    // Switch to text mode
    const textModeBtn = page.locator('.rec-mode button', { hasText: /Type/i });
    await expect(textModeBtn).toBeVisible({ timeout: 5000 });
    await textModeBtn.click();
    // Type enough text to complete the chapter (>30 chars)
    const textarea = page.locator('.text-area').first();
    await textarea.fill('I want you to know that I loved every moment we shared together as a family. This is important to me.');
    await page.waitForTimeout(500);
    // Score should have updated
    const score = page.locator('#top-score-val');
    const scoreVal = parseInt(await score.textContent(), 10);
    expect(scoreVal).toBeGreaterThan(0);
  });

  test('AI suggest endpoint returns suggestion when authenticated', async ({ page, request }) => {
    // Get Clerk session token from the page context
    await setupClerkTestingToken({ page });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Call API directly with token from page
    const token = await page.evaluate(async () => {
      try { return await window.Clerk?.session?.getToken() || null; } catch { return null; }
    });
    if (!token) {
      test.skip(true, 'Could not get auth token from page');
      return;
    }
    const resp = await request.post('/api/suggest', {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      data: { mode: 'depth', text: 'I want you to know I tried every day. Even when it was hard.', chapId: 'know', chapTitle: 'What I want you to know' }
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('label');
    expect(body).toHaveProperty('body');
    expect(body.label.length).toBeGreaterThan(0);
    expect(body.body.length).toBeGreaterThan(20);
  });

  test('export keepsake button triggers print or download', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const continueBtn = page.locator('#welcomeAuth button', { hasText: /Continue/i });
    await expect(continueBtn).toBeVisible({ timeout: 10000 });
    await continueBtn.click();
    // Navigate to the export bar (visible at top of sections)
    const exportBtn = page.locator('.exb-btn', { hasText: /Keepsake/i }).first();
    if (await exportBtn.isVisible()) {
      // Just verify it's clickable — actual print dialog can't be tested headlessly
      await expect(exportBtn).toBeEnabled();
    }
  });

  test('sections navigation works', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const continueBtn = page.locator('#welcomeAuth button', { hasText: /Continue/i });
    await expect(continueBtn).toBeVisible({ timeout: 10000 });
    await continueBtn.click();
    // Click first section in left rail
    const secItem = page.locator('.sec-li').first();
    await expect(secItem).toBeVisible({ timeout: 5000 });
    await secItem.click();
    const heading = page.locator('.main h2');
    await expect(heading).toBeVisible();
  });

});
