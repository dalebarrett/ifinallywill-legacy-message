// E2E suite for Legacy Message™ — covers the password gate, auth gating,
// welcome flow, i18n, delivery UI, billing, federation (HMAC), portals,
// legal pages, and email localization. Clerk is mocked at the browser edge
// (route-abort + window.Clerk stub) so the suite is hermetic and fast;
// signed HTTP calls exercise the real server-side federation paths.
const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
require('dotenv').config();

const CRON_SECRET = process.env.CRON_SECRET || '';
const IFW_SECRET = process.env.IFW_LL_WEBHOOK_SECRET || '';

function hmac(msg) {
  return 'sha256=' + crypto.createHmac('sha256', IFW_SECRET).update(msg).digest('hex');
}

// Mock Clerk in the page: signedIn=true gives a fake user; false gives none.
async function mockClerk(page, signedIn) {
  await page.route('**/clerk.browser.js', (r) => r.abort());
  await page.addInitScript((isIn) => {
    window.Clerk = {
      user: isIn ? { firstName: 'Test', emailAddresses: [{ emailAddress: 'test@example.com' }] } : null,
      session: { getToken: async () => (isIn ? 'fake-token' : null) },
      load: async () => {},
      addListener: () => {},
      mountUserButton: (el) => { el.textContent = '[user]'; },
      openSignIn: () => { window.__openedSignIn = true; },
      openSignUp: () => { window.__openedSignUp = true; },
    };
  }, signedIn);
}

// ─── Password gate ─────────────────────────────────────────────────────────
test.describe('pre-launch gate', () => {
  test('page loads are gated; i18n bundle and APIs are not', async ({ baseURL }) => {
    // Node's fetch — guaranteed credential-free (Playwright request contexts
    // inherit the project's httpCredentials even when newly created).
    expect((await fetch(baseURL + '/')).status).toBe(401);
    expect((await fetch(baseURL + '/executor')).status).toBe(401);
    expect((await fetch(baseURL + '/i18n.js')).status).toBe(200);
    expect((await fetch(baseURL + '/api/billing/plans')).status).toBe(200);
  });
});

// ─── Auth gating on APIs ───────────────────────────────────────────────────
test.describe('API auth', () => {
  const cases = [
    ['POST', '/api/suggest'], ['POST', '/api/transcribe'],
    ['GET', '/api/contacts'], ['POST', '/api/contacts'],
    ['GET', '/api/billing/status'], ['POST', '/api/billing/checkout'],
    ['GET', '/api/admin/metrics'], ['GET', '/api/admin/users'], ['POST', '/api/admin/sweep'],
    ['GET', '/api/portal/inbox'], ['GET', '/api/export'], ['GET', '/api/dashboard'],
    ['GET', '/api/executor/assignments'], ['POST', '/api/executor/report-death'],
  ];
  for (const [method, path] of cases) {
    test(`${method} ${path} -> 401 unauthenticated`, async ({ request, baseURL }) => {
      const r = method === 'GET'
        ? await request.get(baseURL + path)
        : await request.post(baseURL + path, { data: {} });
      expect(r.status()).toBe(401);
    });
  }

  test('cron sweep: 401 without secret, 200 with', async ({ request, baseURL }) => {
    expect((await request.get(baseURL + '/api/cron/sweep')).status()).toBe(401);
    const ok = await request.get(baseURL + '/api/cron/sweep', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(ok.status()).toBe(200);
    const j = await ok.json();
    expect(j.ok).toBe(true);
    expect(typeof j.scanned).toBe('number');
  });

  test('stripe webhook rejects unsigned payloads', async ({ request, baseURL }) => {
    const r = await request.post(baseURL + '/api/webhooks/stripe', { data: {} });
    expect(r.status()).toBe(400);
  });
});

// ─── Billing catalog ───────────────────────────────────────────────────────
test('billing plans are public and complete', async ({ request, baseURL }) => {
  const r = await request.get(baseURL + '/api/billing/plans');
  expect(r.status()).toBe(200);
  const { plans } = await r.json();
  expect(plans.map((p) => p.id).sort()).toEqual(['free', 'lifetime', 'premium_annual', 'premium_monthly']);
});

// ─── IFW federation (HMAC) ─────────────────────────────────────────────────
test.describe('IFW federation', () => {
  test('unsigned requests are rejected', async ({ request, baseURL }) => {
    expect((await request.post(baseURL + '/api/ifw-grant', { data: { email: 'x@y.com' } })).status()).toBe(401);
    expect((await request.get(baseURL + '/api/integrations/metrics')).status()).toBe(401);
    expect((await request.get(baseURL + '/api/integrations/ifinallywill/status?userRef=x@y.com')).status()).toBe(401);
  });

  test('signed metrics returns the unified-dashboard schema', async ({ request, baseURL }) => {
    test.skip(!IFW_SECRET, 'IFW_LL_WEBHOOK_SECRET not set');
    const ts = Math.floor(Date.now() / 1000).toString();
    const r = await request.get(baseURL + '/api/integrations/metrics', {
      headers: { 'X-IFW-Timestamp': ts, 'X-IFW-Signature': hmac(`${ts}./api/integrations/metrics`) },
    });
    expect(r.status()).toBe(200);
    const m = await r.json();
    expect(m.schemaVersion).toBe(1);
    expect(m.product).toBe('legacy');
    for (const k of ['revenue', 'subscribers', 'funnel', 'discounts', 'ops']) expect(m[k]).toBeTruthy();
    expect(m.ops).toHaveProperty('lettersCreated');
  });

  test('grant push rejects tampered signature and stale timestamp', async ({ request, baseURL }) => {
    test.skip(!IFW_SECRET, 'IFW_LL_WEBHOOK_SECRET not set');
    const email = 'tamper@example.com';
    const ts = Math.floor(Date.now() / 1000).toString();
    const bad = await request.post(baseURL + '/api/ifw-grant', {
      headers: { 'X-IFW-Timestamp': ts, 'X-IFW-Signature': hmac(`${ts}.${email}`) + '00' },
      data: { email },
    });
    expect(bad.status()).toBe(401);
    const oldTs = (Math.floor(Date.now() / 1000) - 900).toString();
    const stale = await request.post(baseURL + '/api/ifw-grant', {
      headers: { 'X-IFW-Timestamp': oldTs, 'X-IFW-Signature': hmac(`${oldTs}.${email}`) },
      data: { email },
    });
    expect(stale.status()).toBe(401);
  });

  test('valid grant for unknown email reports pending', async ({ request, baseURL }) => {
    test.skip(!IFW_SECRET, 'IFW_LL_WEBHOOK_SECRET not set');
    const email = `nobody-${Date.now()}@example.com`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const r = await request.post(baseURL + '/api/ifw-grant', {
      headers: { 'X-IFW-Timestamp': ts, 'X-IFW-Signature': hmac(`${ts}.${email}`) },
      data: { email, source: 'will_grant' },
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
  });
});

// ─── Pages serve ───────────────────────────────────────────────────────────
test.describe('pages', () => {
  const pages = [
    ['/', 'Legacy Letter™'],
    ['/executor', 'Executor'],
    ['/portal', 'Legacy Letter™'],
    ['/alive?token=x', 'still'],
    ['/admin', 'Admin'],
    ['/terms', 'Terms of Service'],
    ['/privacy', 'Privacy Policy'],
  ];
  for (const [path, needle] of pages) {
    test(`${path} serves with expected content`, async ({ request, baseURL }) => {
      const r = await request.get(baseURL + path);
      expect(r.status()).toBe(200);
      expect(await r.text()).toContain(needle);
    });
  }
});

// ─── Welcome / auth flow ───────────────────────────────────────────────────
test.describe('welcome flow', () => {
  test('signed out: welcome shows auth buttons and blocks entry', async ({ page }) => {
    await mockClerk(page, false);
    await page.goto('/');
    await page.waitForTimeout(800);
    const gone = await page.evaluate(() => document.getElementById('welcome').classList.contains('gone'));
    expect(gone).toBe(false);
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#welcomeAuth button')).map((b) => b.textContent.trim()));
    expect(labels.length).toBe(2);
    await page.evaluate(() => dismissWelcome());
    expect(await page.evaluate(() => document.getElementById('welcome').classList.contains('gone'))).toBe(false);
    expect(await page.evaluate(() => window.__openedSignIn === true)).toBe(true);
  });

  test('signed in: welcome is bypassed automatically', async ({ page }) => {
    await mockClerk(page, true);
    await page.goto('/');
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.getElementById('welcome').classList.contains('gone'))).toBe(true);
  });
});

// ─── i18n ──────────────────────────────────────────────────────────────────
test.describe('i18n', () => {
  test('switcher exists; UI translates; user content does not', async ({ page }) => {
    await mockClerk(page, true);
    await page.goto('/');
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => !!document.getElementById('lmLangSwitch'))).toBe(true);

    await page.evaluate(() => { currentChapter = 0; currentView = 'chapter'; renderMain(); setMode('text'); });
    await page.evaluate(() => {
      const ta = document.getElementById('textInput');
      ta.value = 'My own private words'; ta.dispatchEvent(new Event('input'));
    });
    await page.evaluate(() => window.LM_setLang('hi'));
    await page.waitForTimeout(500);
    const next = await page.evaluate(() => document.querySelector('.nav .next').textContent.trim());
    expect(next).toContain('अगला'); // "Next chapter" in Hindi
    expect(await page.evaluate(() => document.getElementById('textInput').value)).toBe('My own private words');
    await page.evaluate(() => window.LM_setLang('en'));
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.querySelector('.nav .next').textContent)).toContain('Next chapter');
  });

  test('email templates localize with placeholders filled', async () => {
    const e = require('../legacy-engine');
    for (const lang of ['en', 'fr', 'es', 'pt', 'hi']) {
      const html = e.messageReleasedEmail({ ownerName: 'Olive', recipientName: 'Sam', portalUrl: 'https://x', preview: 'hello', lang });
      expect(html).not.toMatch(/\{(owner|name|days)\}/);
      expect(html.length).toBeGreaterThan(500);
      expect(e.emailSubject('released', lang, { owner: 'Olive' })).toContain('Olive');
    }
  });
});

// ─── Delivery timing UI ────────────────────────────────────────────────────
test('delivery selector reveals date / life-event / conditions inputs', async ({ page }) => {
  await mockClerk(page, true);
  await page.goto('/');
  await page.waitForTimeout(900);
  await page.evaluate(() => { currentChapter = 0; currentView = 'chapter'; renderMain(); });

  await page.evaluate(() => { const s = document.getElementById('delivSel'); s.value = 'specific_date'; s.dispatchEvent(new Event('change')); });
  expect(await page.evaluate(() => !!document.querySelector('#delivRight input[type=date]'))).toBe(true);

  await page.evaluate(() => { const s = document.getElementById('delivSel'); s.value = 'life_event'; s.dispatchEvent(new Event('change')); });
  expect(await page.evaluate(() => !!document.getElementById('delivEvent'))).toBe(true);

  await page.evaluate(() => { const s = document.getElementById('delivSel'); s.value = 'never_unless'; s.dispatchEvent(new Event('change')); });
  expect(await page.evaluate(() => !!document.getElementById('delivConds'))).toBe(true);
});

// ─── Pricing modal ─────────────────────────────────────────────────────────
test('pricing modal renders all four plans', async ({ page }) => {
  await mockClerk(page, true);
  await page.goto('/');
  await page.waitForTimeout(900);
  await page.evaluate(() => openPricing());
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => document.querySelectorAll('#pricingGrid .price-plan').length)).toBe(4);
});

// ─── Anonymous draft → account migration (no silent data loss) ─────────────
test.describe('draft migration', () => {
  const KEY = 'ifw_legacy_letter_v2';
  async function run(page, { localDraft, cloudState }) {
    await page.route('**/clerk.browser.js', (r) => r.abort());
    let saved = null;
    await page.route('**/api/state/load', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: cloudState, savedAt: cloudState ? new Date().toISOString() : null }) }));
    await page.route('**/api/state/save', (r) => { try { saved = JSON.parse(r.request().postData()).state; } catch (e) {} return r.fulfill({ status: 200, body: '{"ok":true}' }); });
    for (const p of ['**/api/billing/status', '**/api/admin/whoami', '**/api/checkin', '**/api/contacts']) {
      await page.route(p, (r) => r.fulfill({ status: 200, body: '{}' }));
    }
    await page.addInitScript(([k, d]) => {
      if (d) localStorage.setItem(k, JSON.stringify(d));
      window.Clerk = { user: { firstName: 'Alex', emailAddresses: [{ emailAddress: 'alex@example.com' }] }, session: { getToken: async () => 't' }, load: async () => {}, addListener: () => {}, mountUserButton: (e) => { e.textContent = 'U'; }, openSignIn: () => {}, openSignUp: () => {} };
    }, [KEY, localDraft]);
    await page.goto('/');
    await page.waitForTimeout(1400);
    return () => saved;
  }

  test('cloud empty + device draft → keeps draft and migrates it up', async ({ page }) => {
    const getSaved = await run(page, { localDraft: { chapters: { know: { text: 'My device draft.' } } }, cloudState: null });
    const text = await page.evaluate(() => (state.chapters.know || {}).text || '');
    expect(text).toBe('My device draft.');
    expect(getSaved()).toBeTruthy(); // pushed to account
  });

  test('conflict → keeping the device letter never loses it', async ({ page }) => {
    const getSaved = await run(page, { localDraft: { chapters: { know: { text: 'DEVICE text.' } } }, cloudState: { chapters: { know: { text: 'ACCOUNT text.' } } } });
    expect(await page.$('#_mcLocal')).toBeTruthy(); // conflict modal shown, not silent
    await page.click('#_mcLocal');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (state.chapters.know || {}).text)).toBe('DEVICE text.');
    expect(getSaved()).toBeTruthy();
  });
});

// ─── Ground Control return link ────────────────────────────────────────────
test.describe('GC return link', () => {
  test('valid fivestarwills return shows the link', async ({ page }) => {
    await mockClerk(page, true);
    await page.goto('/?return=' + encodeURIComponent('https://fivestarwills.ca/app/ground-control'));
    await page.waitForTimeout(700);
    const el = await page.evaluate(() => {
      const a = document.getElementById('gcReturn');
      return { shown: a && a.style.display !== 'none', href: a && a.href };
    });
    expect(el.shown).toBe(true);
    expect(el.href).toContain('fivestarwills.ca');
  });

  test('off-domain return stays hidden', async ({ page }) => {
    await mockClerk(page, true);
    await page.goto('/?return=' + encodeURIComponent('https://evil.example.com/phish'));
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => document.getElementById('gcReturn').style.display)).toBe('none');
  });
});
