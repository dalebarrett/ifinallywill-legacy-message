// ════════════════════════════════════════════════════════════════════════
// legacy-engine.js — Trusted contacts, death verification, scheduling, delivery
//
// DATASTORE NOTE (prototype): all state lives in Clerk private metadata, and
// the cron sweep enumerates Clerk users. This is correct and fully functional
// at small/medium scale. For production scale (indexed "messages due today"
// queries, audit logs, concurrent-write safety) this layer swaps to Postgres
// without changing the route handlers — they only call the helpers below.
// ════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { clerkClient } = require('@clerk/express');

const APP_URL = (process.env.APP_URL || 'https://legacy-message.vercel.app').replace(/\/$/, '');
const FROM = `Legacy Message <noreply@${process.env.EMAIL_FROM_DOMAIN || 'ifinallywill.com'}>`;
const SIGNING_SECRET =
  process.env.TOKEN_SIGNING_SECRET || process.env.CLERK_SECRET_KEY || 'dev-insecure-signing-secret';

// Grace window (days) the owner has to cancel a death report ("proof of life").
const GRACE_DAYS = Number(process.env.VERIFY_GRACE_DAYS || 14);
// How many trusted-contact confirmations are required to verify a death.
const DEFAULT_THRESHOLD = Number(process.env.VERIFY_THRESHOLD || 2);
const DAY_MS = 24 * 3600 * 1000;
const YEAR_MS = Math.round(365.25 * DAY_MS);

// ─── Signed tokens (invites, proof-of-life cancel links) ──────────────────
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Clerk metadata helpers (read-modify-write the whole object) ──────────
async function getMeta(userId) {
  const u = await clerkClient.users.getUser(userId);
  return { user: u, meta: u.privateMetadata || {} };
}
async function setMeta(userId, fullMeta) {
  await clerkClient.users.updateUserMetadata(userId, { privateMetadata: fullMeta });
  return fullMeta;
}
async function patchMeta(userId, patchFn) {
  const { meta } = await getMeta(userId);
  const next = patchFn({ ...meta }) || meta;
  await setMeta(userId, next);
  return next;
}

function displayName(user) {
  if (!user) return 'A Legacy Message member';
  return (
    [user.firstName, user.lastName].filter(Boolean).join(' ') ||
    user.emailAddresses?.[0]?.emailAddress ||
    'A Legacy Message member'
  );
}
function primaryEmail(user) {
  return user?.emailAddresses?.[0]?.emailAddress || null;
}

// ─── Email (no-ops cleanly if RESEND_API_KEY is absent) ───────────────────
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { skipped: true };
  }
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html });
  if (error) throw new Error(error.message || JSON.stringify(error));
  return { id: data?.id };
}

function shell(title, bodyInner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:32px 16px;background:#F2F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 40px rgba(10,42,74,.12)">
<div style="background:linear-gradient(135deg,#0A2A4A,#071E38);padding:34px 40px 28px;text-align:center">
<span style="display:inline-block;background:rgba(245,180,0,.15);border:1px solid rgba(245,180,0,.4);border-radius:20px;padding:4px 14px;color:#F5B800;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase">Legacy Message</span>
</div>
<div style="padding:34px 40px 30px">${bodyInner}</div>
<div style="background:#F2F5F9;padding:18px 40px;text-align:center;border-top:1px solid #E2EBF0"><p style="font-size:11px;color:#8098A8;margin:0;line-height:1.6">Legacy Message · iFinallyWill.com</p></div>
</div></body></html>`;
}
function btn(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#0A2A4A;color:#F5B800;text-decoration:none;font-weight:800;font-size:14px;padding:13px 26px;border-radius:10px">${esc(label)}</a>`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Email templates ──────────────────────────────────────────────────────
function inviteEmail({ ownerName, contactName, role, acceptUrl }) {
  const roleWord = role === 'executor' ? 'executor' : 'trusted contact';
  return shell('You have been named a trusted contact', `
    <h1 style="font-size:22px;color:#0A2A4A;margin:0 0 14px">${esc(ownerName)} has named you their ${esc(roleWord)}</h1>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 10px">Hi ${esc(contactName)},</p>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 22px">${esc(ownerName)} has prepared personal messages for their loved ones on Legacy Message, and has asked you to help make sure those messages reach the right people at the right time. ${role === 'executor' ? 'As their executor, one day you may be the person who confirms their passing so their words can be delivered.' : 'You may one day be asked to help confirm their passing.'} There is nothing you need to do today — just confirm your role.</p>
    <p style="text-align:center;margin:0 0 22px">${btn(acceptUrl, 'Accept this role')}</p>
    <p style="font-size:12px;color:#8098A8;line-height:1.6;margin:0">You will not see any of their private messages while they are alive. We may occasionally remind you that you hold this role and ask you to keep your contact details current.</p>`);
}
function deathReportedToOwnerEmail({ ownerName, reporterName, cancelUrl, graceDays }) {
  return shell('Important: your account was reported', `
    <h1 style="font-size:22px;color:#B91C1C;margin:0 0 14px">Are you still with us?</h1>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 10px">Hi ${esc(ownerName)},</p>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 22px"><strong>${esc(reporterName)}</strong> has reported that you have passed away, which would begin the process of delivering your Legacy Messages. <strong>If this is a mistake — if you are reading this — please tap the button below within ${graceDays} days to stop it.</strong> Nothing will be sent while this window is open.</p>
    <p style="text-align:center;margin:0 0 22px">${btn(cancelUrl, "I'm still here — cancel this")}</p>
    <p style="font-size:12px;color:#8098A8;line-height:1.6;margin:0">If you do nothing and your trusted contacts confirm, your messages will begin to be delivered as you scheduled them. If you no longer want this person as a contact, sign in and remove them.</p>`);
}
function confirmRequestEmail({ ownerName, contactName, reporterName, confirmUrl }) {
  return shell('Please confirm a passing', `
    <h1 style="font-size:22px;color:#0A2A4A;margin:0 0 14px">A passing has been reported</h1>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 10px">Hi ${esc(contactName)},</p>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 22px"><strong>${esc(reporterName)}</strong> has reported the passing of <strong>${esc(ownerName)}</strong>. As one of their trusted contacts, your confirmation helps make sure their final messages are only released when it is truly time. Please sign in and confirm or dispute this report.</p>
    <p style="text-align:center;margin:0 0 22px">${btn(confirmUrl, 'Review and confirm')}</p>
    <p style="font-size:12px;color:#8098A8;line-height:1.6;margin:0">Multiple confirmations are required before anything is delivered. If you believe this is a mistake, please dispute it on the same screen.</p>`);
}
function messageReleasedEmail({ ownerName, recipientName, portalUrl, preview }) {
  return shell(`A message from ${ownerName}`, `
    <h1 style="font-size:22px;color:#0A2A4A;margin:0 0 14px">${esc(ownerName)} left you a message</h1>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 18px">Hi ${esc(recipientName || 'there')},</p>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 18px">${esc(ownerName)} prepared a personal message for you, to be delivered at this moment. It is waiting safely for you in your private Legacy Message space.</p>
    ${preview ? `<blockquote style="border-left:3px solid #F5B800;padding-left:14px;margin:0 0 22px;font-style:italic;color:#5A6E80;font-size:14px;line-height:1.6">"${esc(preview)}…"</blockquote>` : ''}
    <p style="text-align:center;margin:0 0 22px">${btn(portalUrl, 'Read your message')}</p>
    <p style="font-size:12px;color:#8098A8;line-height:1.6;margin:0">For your privacy, you may be asked to verify your identity before viewing.</p>`);
}

// ─── Scheduling: compute when a message is due, from the death anchor ─────
// Returns a Date, or null when the rule needs a human (life event / condition).
function computeDueDate(rule, anchorISO) {
  if (!anchorISO) return null;
  const anchor = new Date(anchorISO).getTime();
  const kind = (rule && rule.delivery) || 'on_passing';
  switch (kind) {
    case 'on_passing':
    case 'executor_unlock':
    case 'anniversary': // legacy alias
      return new Date(anchor + 2 * DAY_MS);
    case '1_year_after':
      return new Date(anchor + YEAR_MS);
    case '5_year_after':
      return new Date(anchor + 5 * YEAR_MS);
    case '10_year_after':
      return new Date(anchor + 10 * YEAR_MS);
    case 'specific_date':
      return rule.deliveryDate ? new Date(rule.deliveryDate + 'T12:00:00Z') : null;
    case 'life_event':
    case 'never_unless':
      return null; // requires manual executor release
    default:
      return new Date(anchor + 2 * DAY_MS);
  }
}
function ruleNeedsHuman(rule) {
  const k = (rule && rule.delivery) || 'on_passing';
  return k === 'life_event' || k === 'never_unless';
}

// ─── Enumerate every message an owner has authored ────────────────────────
// Returns [{ key, kind:'chapter'|'recipient', title, text, rule, toEmail, toName }]
function enumerateMessages(state) {
  if (!state) return [];
  const out = [];
  const chapters = state.chapters || {};
  const recipients = state.recipients || [];
  const people = chapters.people || { recipients: {} };

  // Recipient-specific messages → delivered to that recipient
  recipients.forEach((r) => {
    const rd = (people.recipients || {})[r.id];
    if (rd && rd.text && rd.text.trim().length > 10) {
      out.push({
        key: `recipient:${r.id}`,
        kind: 'recipient',
        title: `For ${r.name}`,
        text: rd.text,
        rule: rd,
        toEmail: r.email || null,
        toName: r.name,
      });
    }
  });

  // Narrative chapters → released to all listed recipients (portal)
  Object.keys(chapters).forEach((chapId) => {
    if (chapId === 'people') return;
    const d = chapters[chapId];
    if (d && d.text && d.text.trim().length > 10) {
      out.push({
        key: `chapter:${chapId}`,
        kind: 'chapter',
        title: d.title || chapId,
        text: d.text,
        rule: d,
        toEmail: null, // broadcast to all recipients in portal
        toName: null,
      });
    }
  });

  return out;
}

// ─── Page through all Clerk users ─────────────────────────────────────────
async function forEachUser(fn) {
  const limit = 100;
  let offset = 0;
  for (;;) {
    const resp = await clerkClient.users.getUserList({ limit, offset });
    const list = Array.isArray(resp) ? resp : resp.data || [];
    for (const u of list) await fn(u);
    if (list.length < limit) break;
    offset += limit;
  }
}

async function findUsersByEmail(email) {
  const resp = await clerkClient.users.getUserList({ emailAddress: [email], limit: 10 });
  return Array.isArray(resp) ? resp : resp.data || [];
}

// ─── Per-user processing (shared by the cron sweep and manual release) ────
// 1) Advance a pending death-report (grace + M-of-N → verified).
// 2) Deliver every due message for a verified-deceased owner (idempotent).
async function processUser(user, now, summary) {
  const meta = user.privateMetadata || {};
  const v = meta.verification;
  if (!v || v.status === 'active' || v.cancelled) return;

  let changed = false;

  // ── Step 1: pending → verified_deceased ──
  if (v.status === 'pending') {
    const confirms = (v.confirmations || []).filter((c) => c.vote === 'confirm').length;
    const disputes = (v.confirmations || []).filter((c) => c.vote === 'dispute').length;
    const graceOver = v.graceUntil && now > new Date(v.graceUntil).getTime();
    const threshold = v.threshold || DEFAULT_THRESHOLD;
    if (graceOver && confirms >= threshold && disputes === 0) {
      v.status = 'verified_deceased';
      v.verifiedAt = new Date(now).toISOString();
      v.deathAnchor = v.deathDate || v.verifiedAt;
      changed = true;
      summary.verified++;
    }
  }

  // ── Step 2: deliver due messages ──
  if (v.status === 'verified_deceased') {
    const state = meta.legacyLetterState;
    const messages = enumerateMessages(state);
    const delivery = meta.delivery || { sent: {}, released: {} };
    delivery.sent = delivery.sent || {};
    delivery.released = delivery.released || {};

    const ownerName = displayName(user);
    const recipientsWithEmail = (state?.recipients || []).filter((r) => r.email);

    for (const m of messages) {
      if (delivery.sent[m.key]) continue; // already delivered

      let due = computeDueDate(m.rule, v.deathAnchor);
      // Human-gated rules become due once an executor manually releases them
      if (ruleNeedsHuman(m.rule)) {
        due = delivery.released[m.key] ? new Date(0) : null;
      }
      if (!due || due.getTime() > now) continue;

      const targets =
        m.kind === 'recipient'
          ? m.toEmail
            ? [{ email: m.toEmail, name: m.toName }]
            : []
          : recipientsWithEmail.map((r) => ({ email: r.email, name: r.name }));

      try {
        for (const t of targets) {
          await sendEmail({
            to: t.email,
            subject: `A message from ${ownerName}`,
            html: messageReleasedEmail({
              ownerName,
              recipientName: t.name,
              portalUrl: `${APP_URL}/portal`,
              preview: m.text.slice(0, 140),
            }),
          });
        }
        delivery.sent[m.key] = {
          at: new Date(now).toISOString(),
          to: targets.map((t) => t.email),
          channel: 'email+portal',
        };
        changed = true;
        summary.delivered++;
      } catch (err) {
        summary.errors.push(`${user.id}/${m.key}: ${err.message}`);
      }
    }
    meta.delivery = delivery;
  }

  if (changed) {
    try {
      await setMeta(user.id, meta);
    } catch (err) {
      summary.errors.push(`save ${user.id}: ${err.message}`);
    }
  }
}

// THE CRON SWEEP — process every user.
async function processSweep() {
  const now = Date.now();
  const summary = { scanned: 0, verified: 0, delivered: 0, errors: [] };
  await forEachUser(async (user) => {
    summary.scanned++;
    await processUser(user, now, summary);
  });
  return summary;
}

// Process a single owner now (used after a manual executor release for instant delivery).
async function sweepUser(userId) {
  const summary = { scanned: 1, verified: 0, delivered: 0, errors: [] };
  const user = await clerkClient.users.getUser(userId);
  await processUser(user, Date.now(), summary);
  return summary;
}

module.exports = {
  APP_URL,
  GRACE_DAYS,
  DEFAULT_THRESHOLD,
  signToken,
  verifyToken,
  getMeta,
  setMeta,
  patchMeta,
  displayName,
  primaryEmail,
  sendEmail,
  inviteEmail,
  deathReportedToOwnerEmail,
  confirmRequestEmail,
  messageReleasedEmail,
  computeDueDate,
  ruleNeedsHuman,
  enumerateMessages,
  forEachUser,
  findUsersByEmail,
  processSweep,
  sweepUser,
  esc,
};
