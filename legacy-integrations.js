// ════════════════════════════════════════════════════════════════════════
// legacy-integrations.js — IFW (I Finally Will) federation
//
// Per IFW Claude's coordination reply (2026-06-07):
//   • Email is the universal key across IFW / Legacy / Pet.
//   • IFW's Postgres is the entitlement source of truth; we keep Clerk.
//   • Server-to-server over HMAC-SHA256, secret = IFW_LL_WEBHOOK_SECRET.
//   • IFW PUSHES will-grants to us (POST /api/ifw-grant); we PULL as a
//     safety net (GET {IFW}/api/integrations/entitlement/check?email=).
//
// All of this no-ops gracefully until the owner sets the shared secret +
// IFW_BASE_URL, so nothing here can break the app before IFW is wired.
// ════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { clerkClient } = require('@clerk/express');

const IFW_BASE = (process.env.IFW_BASE_URL || 'https://fivestarwills.ca').replace(/\/$/, '');
const SECRET = process.env.IFW_LL_WEBHOOK_SECRET || '';
const SKEW_SECONDS = 300; // accept ±5 min, matching IFW's retry window
const PRODUCT = 'legacy';

function configured() { return !!SECRET; }

// ─── HMAC helpers (sha256={hex} over a canonical message) ─────────────────
function sign(message) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(message).digest('hex');
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function timestampFresh(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return false;
  return Math.abs(Date.now() / 1000 - n) <= SKEW_SECONDS;
}
// Verify an incoming IFW request. `message` is the agreed signed string.
function verify(message, timestamp, signature) {
  if (!SECRET || !signature || !timestampFresh(timestamp)) return false;
  return safeEqual(signature, sign(message));
}

// ─── PUSH receiver: IFW → LL grant (message = `${ts}.${email}`) ───────────
function verifyGrant({ timestamp, email, signature }) {
  return verify(`${timestamp}.${String(email).toLowerCase()}`, timestamp, signature);
}
// Apply (or revoke) a will-grant to any Clerk user(s) with this email.
// If the person hasn't signed up on LL yet there's no user to update — that's
// fine: the login-time PULL will catch them. Returns {applied, pending}.
async function applyGrant({ email, source = 'will_grant', willOrderId = null, status = 'active', grantedAt, currentPeriodEnd = null }) {
  const lc = String(email).toLowerCase();
  let resp;
  try {
    resp = await clerkClient.users.getUserList({ emailAddress: [lc], limit: 10 });
  } catch {
    resp = { data: [] };
  }
  const users = Array.isArray(resp) ? resp : resp.data || [];
  if (!users.length) return { applied: 0, pending: true };
  let applied = 0;
  for (const u of users) {
    const meta = u.privateMetadata || {};
    meta.ifwGrant = {
      willCustomer: status === 'active',
      source, status,
      willOrderId: willOrderId || (meta.ifwGrant && meta.ifwGrant.willOrderId) || null,
      currentPeriodEnd, // null = perpetual (will_grant/comp); set for stripe_sub grants
      grantedAt: grantedAt || new Date().toISOString(),
    };
    try {
      await clerkClient.users.updateUserMetadata(u.id, { privateMetadata: meta });
      applied++;
    } catch { /* skip */ }
  }
  return { applied, pending: false };
}

// ─── PULL client: LL → IFW entitlement check (safety net) ─────────────────
const _cache = new Map(); // email → { at, value }
const CACHE_TTL_MS = 5 * 60 * 1000;
async function fetchEntitlement(email) {
  if (!configured() || !email) return null;
  const lc = String(email).toLowerCase();
  const hit = _cache.get(lc);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const ts = Math.floor(Date.now() / 1000).toString();
  try {
    const url = `${IFW_BASE}/api/integrations/entitlement/check?email=${encodeURIComponent(lc)}`;
    const r = await fetch(url, {
      headers: { 'X-IFW-Timestamp': ts, 'X-IFW-Signature': sign(`${ts}.${lc}`) },
    });
    if (!r.ok) return null;
    const data = await r.json();
    _cache.set(lc, { at: Date.now(), value: data });
    return data;
  } catch {
    return null; // IFW unreachable → fall back to local entitlement
  }
}
// Returns true if IFW says this email is premium on Legacy Letter.
function ifwSaysPremium(data) {
  if (!data) return false;
  if (data.willCustomer === true) return true;
  const g = data.grants && data.grants[PRODUCT];
  return !!(g && g.premium);
}
// Persist an IFW pull result locally so subsequent checks are instant.
async function persistGrantFromPull(userId, data) {
  if (!ifwSaysPremium(data)) return;
  try {
    const u = await clerkClient.users.getUser(userId);
    const meta = u.privateMetadata || {};
    const g = (data.grants && data.grants[PRODUCT]) || {};
    meta.ifwGrant = {
      willCustomer: data.willCustomer === true,
      source: data.willCustomer ? 'will_grant' : g.source || 'stripe_sub',
      status: 'active',
      currentPeriodEnd: g.currentPeriodEnd || null,
      grantedAt: new Date().toISOString(),
    };
    await clerkClient.users.updateUserMetadata(userId, { privateMetadata: meta });
  } catch { /* non-fatal */ }
}

// ─── Signed metrics endpoint verification (IFW → LL) ──────────────────────
// IFW didn't pin the metrics payload; we use `${ts}.${path}` and report it
// back so IFW signs the same. Path = '/api/integrations/metrics'.
const METRICS_PATH = '/api/integrations/metrics';
function verifyMetricsRequest(timestamp, signature) {
  return verify(`${timestamp}.${METRICS_PATH}`, timestamp, signature);
}

// IFW → LL status check (drives the Ground Control tile). Signed over
// `${ts}.${userRef}` (userRef = email), mirroring the grant scheme.
function verifyUserRef(timestamp, userRef, signature) {
  return verify(`${timestamp}.${String(userRef || '').toLowerCase()}`, timestamp, signature);
}

module.exports = {
  IFW_BASE, PRODUCT, METRICS_PATH,
  configured, sign, verify,
  verifyGrant, applyGrant,
  fetchEntitlement, ifwSaysPremium, persistGrantFromPull,
  verifyMetricsRequest, verifyUserRef,
};
