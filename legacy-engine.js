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
const FROM = `Legacy Letter <noreply@${process.env.EMAIL_FROM_DOMAIN || 'ifinallywill.com'}>`;
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
  if (!user) return 'A Legacy Letter™ member';
  return (
    [user.firstName, user.lastName].filter(Boolean).join(' ') ||
    user.emailAddresses?.[0]?.emailAddress ||
    'A Legacy Letter™ member'
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
<span style="display:inline-block;background:rgba(245,180,0,.15);border:1px solid rgba(245,180,0,.4);border-radius:20px;padding:4px 14px;color:#F5B800;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase">Legacy Letter™</span>
</div>
<div style="padding:34px 40px 30px">${bodyInner}</div>
<div style="background:#F2F5F9;padding:18px 40px;text-align:center;border-top:1px solid #E2EBF0"><p style="font-size:11px;color:#8098A8;margin:0;line-height:1.6">Legacy Letter™ · iFinallyWill.com</p></div>
</div></body></html>`;
}
function btn(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#0A2A4A;color:#F5B800;text-decoration:none;font-weight:800;font-size:14px;padding:13px 26px;border-radius:10px">${esc(label)}</a>`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Email copy (localizable) ─────────────────────────────────────────────
// English is the inline source of truth. emails-i18n.json holds fr/es/pt/hi
// versions of the SAME keys with the SAME {placeholders}; any missing key
// falls back to English per-key, so a translation gap can never break email.
const EN_EMAILS = {
  invite: {
    subject: '{owner} named you a trusted contact',
    subjectReminder: 'Reminder: {owner} named you a trusted contact',
    pageTitle: 'You have been named a trusted contact',
    h1: '{owner} has named you their {role}',
    roleExecutor: 'executor',
    roleVerifier: 'trusted contact',
    hi: 'Hi {name},',
    body: '{owner} has prepared personal messages for their loved ones on Legacy Letter™, and has asked you to help make sure those messages reach the right people at the right time.',
    bodyExecutor: 'As their executor, one day you may be the person who confirms their passing so their words can be delivered.',
    bodyVerifier: 'You may one day be asked to help confirm their passing.',
    bodyEnd: 'There is nothing you need to do today — just confirm your role.',
    btn: 'Accept this role',
    foot: 'You will not see any of their private messages while they are alive. We may occasionally remind you that you hold this role and ask you to keep your contact details current.',
  },
  reported: {
    subject: 'Important: please confirm you are still here',
    pageTitle: 'Important: your account was reported',
    h1: 'Are you still with us?',
    hi: 'Hi {name},',
    body: '{reporter} has reported that you have passed away, which would begin the process of delivering your Legacy Letters™.',
    bodyStrong: 'If this is a mistake — if you are reading this — please tap the button below within {days} days to stop it.',
    bodyEnd: 'Nothing will be sent while this window is open.',
    btn: "I'm still here — cancel this",
    foot: 'If you do nothing and your trusted contacts confirm, your messages will begin to be delivered as you scheduled them. If you no longer want this person as a contact, sign in and remove them.',
  },
  confirm: {
    subject: 'Please confirm: a passing was reported for {owner}',
    pageTitle: 'Please confirm a passing',
    h1: 'A passing has been reported',
    hi: 'Hi {name},',
    body: '{reporter} has reported the passing of {owner}. As one of their trusted contacts, your confirmation helps make sure their final messages are only released when it is truly time. Please sign in and confirm or dispute this report.',
    btn: 'Review and confirm',
    foot: 'Multiple confirmations are required before anything is delivered. If you believe this is a mistake, please dispute it on the same screen.',
  },
  released: {
    subject: 'A message from {owner}',
    pageTitle: 'A message from {owner}',
    h1: '{owner} left you a message',
    hi: 'Hi {name},',
    body: '{owner} prepared a personal message for you, to be delivered at this moment. It is waiting safely for you in your private Legacy Letter™ space.',
    btn: 'Read your message',
    foot: 'For your privacy, you may be asked to verify your identity before viewing.',
  },
  dmsOwner: {
    subject: 'A gentle check-in from Legacy Letter™',
    pageTitle: 'A gentle check-in',
    h1: "Just checking you're okay",
    body: 'Hi {name}, it\'s been about {days} days since you last checked in on Legacy Letter™. No alarm — we just quietly keep watch so your messages are only ever delivered at the right time. Please open the app and tap "Check in" so we know all is well.',
    btn: 'Check in now',
  },
  dmsExec: {
    subject: 'Please check on {owner}',
    pageTitle: 'Please check on someone',
    h1: 'A quiet heads-up',
    hi: 'Hi {name},',
    body: "{owner} named you a trusted contact on Legacy Letter™ and hasn't checked in for about {days} days. This is just a backstop reminder — it does not mean anything has happened. If you're able, please check in on them. If something has happened, you can begin the confirmation process in your portal.",
    btn: 'Open executor portal',
  },
};
let EMAIL_I18N = {};
try { EMAIL_I18N = require('./emails-i18n.json'); } catch { /* English-only until generated */ }

// Copy for one template in one language, per-key EN fallback.
function emailCopy(kind, lang) {
  const en = EN_EMAILS[kind] || {};
  const loc = (lang && lang !== 'en' && EMAIL_I18N[lang] && EMAIL_I18N[lang][kind]) || {};
  return { ...en, ...loc };
}
// Fill {placeholders}; values are HTML-escaped (use for HTML contexts).
function fill(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? esc(vars[k]) : m));
}
// Same, without escaping (for plain-text subjects).
function fillPlain(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}
// Fill where some vars are pre-rendered HTML (e.g. <strong>-wrapped names).
function fillRich(tpl, plainVars, htmlVars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => {
    if (htmlVars && htmlVars[k] != null) return htmlVars[k];
    if (plainVars && plainVars[k] != null) return esc(plainVars[k]);
    return m;
  });
}
function emailSubject(kind, lang, vars, variant) {
  const c = emailCopy(kind, lang);
  return fillPlain(variant === 'reminder' ? c.subjectReminder || c.subject : c.subject, vars);
}

const P = 'font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 22px';
const PHI = 'font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 10px';
const FOOT = 'font-size:12px;color:#8098A8;line-height:1.6;margin:0';

// ─── Email templates ──────────────────────────────────────────────────────
function inviteEmail({ ownerName, contactName, role, acceptUrl, lang }) {
  const c = emailCopy('invite', lang);
  const roleWord = role === 'executor' ? c.roleExecutor : c.roleVerifier;
  return shell(fillPlain(c.pageTitle, {}), `
    <h1 style="font-size:22px;color:#0A2A4A;margin:0 0 14px">${fill(c.h1, { owner: ownerName, role: roleWord })}</h1>
    <p style="${PHI}">${fill(c.hi, { name: contactName })}</p>
    <p style="${P}">${fill(c.body, { owner: ownerName })} ${role === 'executor' ? c.bodyExecutor : c.bodyVerifier} ${c.bodyEnd}</p>
    <p style="text-align:center;margin:0 0 22px">${btn(acceptUrl, c.btn)}</p>
    <p style="${FOOT}">${c.foot}</p>`);
}
function deathReportedToOwnerEmail({ ownerName, reporterName, cancelUrl, graceDays, lang }) {
  const c = emailCopy('reported', lang);
  return shell(fillPlain(c.pageTitle, {}), `
    <h1 style="font-size:22px;color:#B91C1C;margin:0 0 14px">${c.h1}</h1>
    <p style="${PHI}">${fill(c.hi, { name: ownerName })}</p>
    <p style="${P}">${fillRich(c.body, {}, { reporter: `<strong>${esc(reporterName)}</strong>` })}</p>
    <p style="${P}"><strong>${fill(c.bodyStrong, { days: graceDays })}</strong> ${c.bodyEnd}</p>
    <p style="text-align:center;margin:0 0 22px">${btn(cancelUrl, c.btn)}</p>
    <p style="${FOOT}">${c.foot}</p>`);
}
function confirmRequestEmail({ ownerName, contactName, reporterName, confirmUrl, lang }) {
  const c = emailCopy('confirm', lang);
  return shell(fillPlain(c.pageTitle, {}), `
    <h1 style="font-size:22px;color:#0A2A4A;margin:0 0 14px">${c.h1}</h1>
    <p style="${PHI}">${fill(c.hi, { name: contactName })}</p>
    <p style="${P}">${fillRich(c.body, {}, { reporter: `<strong>${esc(reporterName)}</strong>`, owner: `<strong>${esc(ownerName)}</strong>` })}</p>
    <p style="text-align:center;margin:0 0 22px">${btn(confirmUrl, c.btn)}</p>
    <p style="${FOOT}">${c.foot}</p>`);
}
function messageReleasedEmail({ ownerName, recipientName, portalUrl, preview, lang }) {
  const c = emailCopy('released', lang);
  return shell(fillPlain(c.pageTitle, { owner: ownerName }), `
    <h1 style="font-size:22px;color:#0A2A4A;margin:0 0 14px">${fill(c.h1, { owner: ownerName })}</h1>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 18px">${fill(c.hi, { name: recipientName || 'there' })}</p>
    <p style="font-size:14px;color:#5A6E80;line-height:1.6;margin:0 0 18px">${fill(c.body, { owner: ownerName })}</p>
    ${preview ? `<blockquote style="border-left:3px solid #F5B800;padding-left:14px;margin:0 0 22px;font-style:italic;color:#5A6E80;font-size:14px;line-height:1.6">"${esc(preview)}…"</blockquote>` : ''}
    <p style="text-align:center;margin:0 0 22px">${btn(portalUrl, c.btn)}</p>
    <p style="${FOOT}">${c.foot}</p>`);
}

// ─── SMS via Twilio REST (no SDK dependency; no-ops without credentials) ──
async function sendSMS({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !tok || !from || !to) {
    console.info(`[sms skipped — Twilio not configured or no number] to=${to || '(none)'}`);
    return { skipped: true };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Twilio ${resp.status}: ${t.slice(0, 180)}`);
  }
  return resp.json();
}
function ownerPhone(user) {
  return user?.phoneNumbers?.[0]?.phoneNumber || null;
}

// ─── Audit log (append-only, newest first, capped) ────────────────────────
function pushAudit(meta, action, actor, detail) {
  meta.auditLog = meta.auditLog || [];
  meta.auditLog.unshift({ at: new Date().toISOString(), action, actor: actor || 'system', detail: detail || '' });
  if (meta.auditLog.length > 200) meta.auditLog.length = 200;
  return meta;
}

// ─── Dead-man's-switch escalation emails ──────────────────────────────────
function dmsOwnerEmail({ ownerName, days, url, lang }) {
  const c = emailCopy('dmsOwner', lang);
  return shell(fillPlain(c.pageTitle, {}), `
    <h1 style="font-size:22px;color:#0A2A4A;margin:0 0 14px">${c.h1}</h1>
    <p style="${P}">${fill(c.body, { name: ownerName, days })}</p>
    <p style="text-align:center;margin:0 0 8px">${btn(url, c.btn)}</p>`);
}
function dmsExecutorEmail({ ownerName, contactName, days, portalUrl, lang }) {
  const c = emailCopy('dmsExec', lang);
  return shell(fillPlain(c.pageTitle, {}), `
    <h1 style="font-size:22px;color:#0A2A4A;margin:0 0 14px">${c.h1}</h1>
    <p style="${PHI}">${fill(c.hi, { name: contactName })}</p>
    <p style="${P}">${fillRich(c.body, { days }, { owner: `<strong>${esc(ownerName)}</strong>` })}</p>
    <p style="text-align:center;margin:0 0 8px">${btn(portalUrl, c.btn)}</p>`);
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

// Has this user entered any data yet? (drives IFW's Ground Control tile state)
function hasLetterData(meta) {
  const st = meta && meta.legacyLetterState;
  if (st) {
    const chapters = st.chapters || {};
    for (const k of Object.keys(chapters)) {
      if (k === 'people') continue;
      if (chapters[k] && (chapters[k].text || '').trim()) return true;
    }
    const recips = (chapters.people && chapters.people.recipients) || {};
    for (const id of Object.keys(recips)) if ((recips[id].text || '').trim()) return true;
    if (st.sections && Object.values(st.sections).some((s) => s && Object.keys(s).length)) return true;
    if (Array.isArray(st.recipients) && st.recipients.some((r) => r.email || r.phone)) return true;
  }
  if ((meta && meta.trustedContacts || []).length) return true;
  return false;
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
        mediaKey: rd.mediaKey || null,
        mediaType: rd.mediaType || null,
        toEmail: r.email || null,
        toPhone: r.phone || null,
        toName: r.name,
        toLang: r.lang || null,
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
        mediaKey: d.mediaKey || null,
        mediaType: d.mediaType || null,
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
async function processDms(user, meta, now, summary) {
  const v = meta.verification;
  if (v && (v.status === 'pending' || v.status === 'verified_deceased')) return false;
  const activeContacts = (meta.trustedContacts || []).filter((c) => c.status === 'active' && c.email);
  if (!activeContacts.length) return false; // nobody to escalate to → skip

  // Snooze: stay completely silent until the snooze expires.
  const snoozeMs = meta.dmsSnoozeUntil ? new Date(meta.dmsSnoozeUntil).getTime() : 0;
  if (snoozeMs && now < snoozeMs) return false;

  const REMIND = Number(process.env.DMS_REMIND_DAYS || 60);
  const ESCALATE = Number(process.env.DMS_ESCALATE_DAYS || 90);
  const REPEAT = 14 * DAY_MS;
  // Baseline = most recent of last check-in, account creation, or a snooze that
  // just expired — so after a 1-year snooze the gentle countdown starts fresh
  // (reminder first, then escalation) instead of escalating instantly.
  const baseline = Math.max(
    meta.lastCheckin ? new Date(meta.lastCheckin).getTime() : user.createdAt || now,
    snoozeMs
  );
  const days = Math.floor((now - baseline) / DAY_MS);
  const esc = meta.checkinEscalation || {};
  let changed = false;

  const ownerLang = (meta.legacyLetterState && meta.legacyLetterState._lang) || 'en';
  if (days >= ESCALATE) {
    if (!esc.lastExecutorNudge || now - new Date(esc.lastExecutorNudge).getTime() > REPEAT) {
      for (const c of activeContacts) {
        try {
          await sendEmail({ to: c.email, subject: emailSubject('dmsExec', c.lang, { owner: displayName(user) }), html: dmsExecutorEmail({ ownerName: displayName(user), contactName: c.name, days, portalUrl: `${APP_URL}/executor`, lang: c.lang }) });
        } catch (e) { summary.errors.push(`dms-exec-email ${user.id}: ${e.message}`); }
        if (c.phone) { try { await sendSMS({ to: c.phone, body: `${displayName(user)} hasn't checked in on Legacy Letter for ${days} days. Please check on them: ${APP_URL}/executor` }); } catch (e) { summary.errors.push(`dms-exec-sms: ${e.message}`); } }
      }
      esc.lastExecutorNudge = new Date(now).toISOString();
      pushAudit(meta, 'dms_escalated_to_contacts', 'system', `${days} days without check-in`);
      changed = true;
      summary.escalated = (summary.escalated || 0) + 1;
    }
  } else if (days >= REMIND) {
    if (!esc.lastOwnerNudge || now - new Date(esc.lastOwnerNudge).getTime() > REPEAT) {
      const email = primaryEmail(user);
      if (email) { try { await sendEmail({ to: email, subject: emailSubject('dmsOwner', ownerLang, {}), html: dmsOwnerEmail({ ownerName: displayName(user), days, url: APP_URL, lang: ownerLang }) }); } catch (e) { summary.errors.push(`dms-owner-email: ${e.message}`); } }
      const ph = ownerPhone(user);
      if (ph) { try { await sendSMS({ to: ph, body: `A gentle check-in from Legacy Letter — please open the app to confirm you're here: ${APP_URL}` }); } catch (e) { summary.errors.push(`dms-owner-sms: ${e.message}`); } }
      esc.lastOwnerNudge = new Date(now).toISOString();
      pushAudit(meta, 'dms_reminded_owner', 'system', `${days} days without check-in`);
      changed = true;
    }
  }
  if (changed) meta.checkinEscalation = esc;
  return changed;
}

async function processUser(user, now, summary) {
  const meta = user.privateMetadata || {};
  const v = meta.verification;
  let changed = false;

  // ── Dead-man's-switch backstop for living owners ──
  if (!v || v.status === 'active') {
    if (await processDms(user, meta, now, summary)) changed = true;
    if (!v || v.status === 'active') {
      if (changed) { try { await setMeta(user.id, meta); } catch (e) { summary.errors.push(`save ${user.id}: ${e.message}`); } }
      return;
    }
  }

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
      pushAudit(meta, 'verified_deceased', 'system', `${confirms} confirmations, grace window elapsed`);
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
            ? [{ email: m.toEmail, name: m.toName, lang: m.toLang }]
            : []
          : recipientsWithEmail.map((r) => ({ email: r.email, name: r.name, lang: r.lang }));

      try {
        for (const t of targets) {
          await sendEmail({
            to: t.email,
            subject: emailSubject('released', t.lang, { owner: ownerName }),
            html: messageReleasedEmail({
              ownerName,
              recipientName: t.name,
              portalUrl: `${APP_URL}/portal`,
              preview: m.text.slice(0, 140),
              lang: t.lang,
            }),
          });
        }
        delivery.sent[m.key] = {
          at: new Date(now).toISOString(),
          to: targets.map((t) => t.email),
          channel: 'email+portal',
        };
        // SMS nudge to recipients who have a phone on file
        if (m.kind === 'recipient' && m.toPhone) {
          try { await sendSMS({ to: m.toPhone, body: `${ownerName} left you a message on Legacy Letter. Read it here: ${APP_URL}/portal` }); } catch (e) { summary.errors.push(`sms ${m.key}: ${e.message}`); }
        }
        pushAudit(meta, 'message_delivered', 'system', `${m.title} → ${targets.map((t) => t.email).join(', ') || 'portal'}`);
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
  ownerPhone,
  sendEmail,
  sendSMS,
  pushAudit,
  emailSubject,
  emailCopy,
  EN_EMAILS,
  inviteEmail,
  deathReportedToOwnerEmail,
  confirmRequestEmail,
  messageReleasedEmail,
  dmsOwnerEmail,
  dmsExecutorEmail,
  computeDueDate,
  ruleNeedsHuman,
  enumerateMessages,
  hasLetterData,
  forEachUser,
  findUsersByEmail,
  processSweep,
  sweepUser,
  esc,
};
