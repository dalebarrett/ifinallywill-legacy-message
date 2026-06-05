require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');

// ─── STARTUP GUARDS ──────────────────────────────────
if (!process.env.CLERK_SECRET_KEY) {
  console.warn('WARNING: CLERK_SECRET_KEY not set — auth middleware will not verify tokens.');
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY not set — AI suggestions will fail.');
}
if (!process.env.OPENAI_API_KEY) {
  console.info('INFO: OPENAI_API_KEY not set — transcription disabled (users type manually).');
}

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

app.use(express.json({ limit: '10mb' }));

// Vercel serverless only allows writes to /tmp; fall back to local tmp/ in dev
const TMP_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'tmp');

// File size limit: Whisper's 25 MB cap; audio MIME types only
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are accepted'), false);
    }
  }
});

// Clerk auth middleware — attaches auth state to every request
app.use(clerkMiddleware());

// Lazily constructed so startup proceeds even without keys
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// HTML-encode a value for use inside a double-quoted HTML attribute
function htmlEncode(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const SYSTEM_PROMPT = `You are a compassionate writing coach helping people write meaningful legacy letters for their families. \
You understand that these messages will be read after the writer has passed, so they carry profound weight. \
You are warm, specific, and encouraging. You help people find the concrete details and honest feelings that make a message memorable. \
You never use clichés or generic advice. You speak directly to the writer, not about them. \
You MUST respond with valid JSON only, no markdown, no explanation outside the JSON: {"label": "...", "body": "..."}`;

const MODE_PROMPTS = {
  depth: (chapTitle, text) => `The user is writing a legacy letter chapter titled "${chapTitle}". Here is what they've written so far:\n\n"${text}"\n\nSuggest one specific detail, memory, or moment they could add to make this message more personal and memorable. Give them a concrete example they could adapt — not a vague direction. Return JSON: {"label": "A short 4-6 word title for your suggestion", "body": "One paragraph the user could add or adapt, written in a natural first-person voice"}`,

  tighten: (chapTitle, text) => `Here is a legacy letter passage from the chapter "${chapTitle}":\n\n"${text}"\n\nRewrite this to be more concise and emotionally direct. Cut the vague parts; keep the specific ones. Preserve the writer's voice — it should still sound like them. Return JSON: {"label": "A short label like \\"Tighter version\\"", "body": "The rewritten passage, keeping the same length or shorter"}`,

  check: (chapTitle, text) => `Read this legacy letter passage from the "${chapTitle}" chapter:\n\n"${text}"\n\nIdentify the core emotional theme. Then name one thing that feels unfinished or unsaid — something the writer might not have noticed they left out. Be gentle and specific. Return JSON: {"label": "A short 4-6 word observation label", "body": "1-2 sentences: what the message is really about, and what might still need saying"}`,

  expand: (chapTitle, text) => `The user is writing a legacy letter chapter titled "${chapTitle}". Here is what they've written so far:\n\n"${text}"\n\nSuggest one meaningful line or paragraph they could add to expand on their message. Make it concrete and personal — help them say the thing they haven't quite said yet. Return JSON: {"label": "A short 4-6 word label for this addition", "body": "One paragraph the user could add or adapt, written in a natural first-person voice"}`,

  missing: (chapTitle, text) => `Read this legacy letter passage from the "${chapTitle}" chapter:\n\n"${text}"\n\nName the one thing that feels most absent — the emotional core that hasn't been expressed yet. Be gentle, specific, and direct. Return JSON: {"label": "A short 4-6 word label for what's missing", "body": "1-2 sentences naming what's not yet in the message and why it might matter"}`
};

const VALID_MODES = new Set(Object.keys(MODE_PROMPTS));

const EMPTY_RESPONSES = {
  depth: { label: 'A way to begin', body: 'Start with one specific memory — a moment you can picture clearly. Even one concrete detail will pull the rest of the message with it. Where were you? Who was there? What did it smell or sound like?' },
  tighten: { label: 'Nothing to tighten yet', body: 'You haven\'t written anything yet. Add your message first, then come back and I\'ll help you sharpen it.' },
  check: { label: 'Start here', body: 'You haven\'t written anything yet. Try this: imagine the person who will hear this message. What is the one thing you most want them to know — something they might not already?' },
  expand: { label: 'Start writing first', body: 'Add your message first, then come back and I\'ll help you expand it.' },
  missing: { label: 'Start here', body: 'You haven\'t written anything yet. Try this: imagine the person who will hear this message. What is the one thing you most want them to know?' }
};

// Helper: return 401 when request is unauthenticated
function requireAuth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── SERVE HTML WITH CLERK SCRIPT INJECTED ───────
app.get('/', (req, res) => {
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, 'legacy_letter.html'), 'utf8');
  } catch (err) {
    console.error('Could not read legacy_letter.html:', err.message);
    return res.status(500).send('Application error — legacy_letter.html not found.');
  }
  const pk = process.env.CLERK_PUBLISHABLE_KEY || '';
  let tag = '';
  if (pk) {
    try {
      // Derive the Clerk frontend API domain from the publishable key
      const b64 = pk.replace(/^pk_(test|live)_/, '');
      const domain = Buffer.from(b64, 'base64').toString('utf8').replace(/\$$/, '');
      tag = `<script async crossorigin="anonymous" data-clerk-publishable-key="${htmlEncode(pk)}" src="https://${htmlEncode(domain)}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js" type="text/javascript"></script>`;
    } catch {
      tag = `<script async src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"></script><script>window.__CLERK_PK_FALLBACK__="${htmlEncode(pk)}";</script>`;
    }
  }
  html = html.replace('</head>', `${tag}\n</head>`);
  res.type('html').send(html);
});

// ─── AI SUGGESTIONS (auth required) ─────────────
app.post('/api/suggest', requireAuth, async (req, res) => {
  const { mode, text, chapId, chapTitle } = req.body;

  // Validate mode
  if (mode && !VALID_MODES.has(mode)) {
    return res.status(400).json({ error: 'Unknown mode. Must be one of: ' + [...VALID_MODES].join(', ') });
  }

  if (!text || text.trim().length < 10) {
    return res.json(EMPTY_RESPONSES[mode] || EMPTY_RESPONSES.depth);
  }

  const promptFn = MODE_PROMPTS[mode] || MODE_PROMPTS.depth;
  const userPrompt = promptFn(chapTitle || chapId || 'your chapter', text.trim());

  try {
    const message = await getAnthropic().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: userPrompt }]
    });

    if (!message.content?.length || message.content[0].type !== 'text') {
      throw new Error('Unexpected response shape from Claude');
    }

    const raw = message.content[0].text.trim();
    let result;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(match ? match[0] : raw);
      if (!result.label || !result.body) throw new Error('missing fields');
    } catch {
      result = { label: 'Writing suggestion', body: raw.replace(/^["']|["']$/g, '') };
    }

    res.json(result);
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ label: 'Error', body: 'Could not get suggestion — check your ANTHROPIC_API_KEY.' });
  }
});

// ─── TRANSCRIPTION (auth required) ──────────────
app.post('/api/transcribe', requireAuth, upload.single('audio'), async (req, res) => {
  const tmpPath = req.file ? req.file.path : null;

  if (!tmpPath) {
    return res.json({ text: '' });
  }

  if (!process.env.OPENAI_API_KEY) {
    cleanup(tmpPath);
    return res.json({ text: '', info: 'Set OPENAI_API_KEY to enable auto-transcription.' });
  }

  try {
    const transcription = await getOpenAI().audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      response_format: 'text'
    });

    const text = typeof transcription === 'string' ? transcription : (transcription.text || '');
    res.json({ text: text.trim() });
  } catch (err) {
    console.error('Transcription error:', err.message);
    res.json({ text: '', error: err.message });
  } finally {
    cleanup(tmpPath);
  }
});

function cleanup(filePath) {
  try { if (filePath) fs.unlinkSync(filePath); } catch {}
}

// ─── CLOUD STATE SAVE ────────────────────────────
app.post('/api/state/save', requireAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const { state } = req.body;
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ error: 'Missing state object' });
  }
  try {
    await clerkClient.users.updateUserMetadata(userId, {
      privateMetadata: { legacyLetterState: state, savedAt: new Date().toISOString() }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('State save error:', err.message);
    res.status(500).json({ error: 'Failed to save state' });
  }
});

// ─── CLOUD STATE LOAD ────────────────────────────
app.get('/api/state/load', requireAuth, async (req, res) => {
  const { userId } = getAuth(req);
  try {
    const user = await clerkClient.users.getUser(userId);
    const pm = user.privateMetadata || {};
    res.json({ state: pm.legacyLetterState || null, savedAt: pm.savedAt || null });
  } catch (err) {
    console.error('State load error:', err.message);
    res.status(500).json({ error: 'Failed to load state' });
  }
});

// ─── DEAD MAN'S SWITCH CHECK-IN ──────────────────
app.post('/api/checkin', requireAuth, async (req, res) => {
  const { userId } = getAuth(req);
  try {
    const user = await clerkClient.users.getUser(userId);
    const pm = user.privateMetadata || {};
    await clerkClient.users.updateUserMetadata(userId, {
      privateMetadata: { ...pm, lastCheckin: new Date().toISOString() }
    });
    res.json({ ok: true, checkedIn: new Date().toISOString() });
  } catch (err) {
    console.error('Check-in error:', err.message);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

app.get('/api/checkin', requireAuth, async (req, res) => {
  const { userId } = getAuth(req);
  try {
    const user = await clerkClient.users.getUser(userId);
    const pm = user.privateMetadata || {};
    res.json({ lastCheckin: pm.lastCheckin || null });
  } catch (err) {
    console.error('Check-in status error:', err.message);
    res.status(500).json({ error: 'Failed to get check-in status' });
  }
});

// ─── EMAIL DELIVERY ───────────────────────────────
app.post('/api/send', requireAuth, async (req, res) => {
  const { to, recipientName, chapters, senderName } = req.body;
  if (!to || !Array.isArray(to) || to.length === 0) {
    return res.status(400).json({ error: 'Missing recipient email address' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'Email delivery not configured — set RESEND_API_KEY.' });
  }
  const { Resend } = require('resend');
  const resendClient = new Resend(process.env.RESEND_API_KEY);
  const emailHtml = buildLegacyLetterEmail({ senderName, recipientName, chapters });
  try {
    const { data, error } = await resendClient.emails.send({
      from: `Legacy Message <noreply@${process.env.EMAIL_FROM_DOMAIN || 'ifinallywill.com'}>`,
      to,
      subject: `A personal message from ${senderName || 'someone who loves you'}`,
      html: emailHtml
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
    res.json({ ok: true, id: data?.id });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

function buildLegacyLetterEmail({ senderName, recipientName, chapters }) {
  const name = htmlEncode(senderName || 'Someone who loves you');
  const recipient = htmlEncode(recipientName || 'you');
  const chaptersHtml = (chapters || [])
    .filter(ch => ch.text && ch.text.trim().length > 20)
    .map(ch => `
    <div style="margin-bottom:28px;padding-bottom:28px;border-bottom:1px solid #E8EDF2">
      <div style="font-size:10px;font-weight:800;color:#8098A8;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">${htmlEncode(ch.chapterTitle || '')}</div>
      <div style="font-size:15px;line-height:1.8;color:#1A2F42;white-space:pre-wrap">${htmlEncode(ch.text)}</div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A message for ${recipient}</title></head>
<body style="margin:0;padding:32px 16px;background:#F2F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 40px rgba(10,42,74,.13)">
    <div style="background:linear-gradient(135deg,#0A2A4A 0%,#071E38 100%);padding:42px 48px 36px;text-align:center">
      <div style="display:inline-block;background:rgba(245,180,0,.15);border:1px solid rgba(245,180,0,.4);border-radius:20px;padding:4px 14px;margin-bottom:16px">
        <span style="color:#F5B800;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase">Legacy Message</span>
      </div>
      <h1 style="color:#fff;font-size:26px;font-weight:900;margin:0 0 10px;line-height:1.3">A message from<br>${name}</h1>
      <p style="color:rgba(255,255,255,.6);font-size:13px;margin:0">Written with love, for ${recipient}</p>
    </div>
    <div style="padding:36px 48px 28px">
      <p style="font-size:14px;color:#5A6E80;font-style:italic;border-left:3px solid #F5B800;padding-left:14px;margin:0 0 28px;line-height:1.6">
        This is a personal message that ${name} prepared for you. Read it in a quiet moment.
      </p>
      ${chaptersHtml || '<p style="color:#8098A8;font-style:italic;font-size:14px">No messages were included.</p>'}
    </div>
    <div style="background:#F2F5F9;padding:22px 48px;text-align:center;border-top:1px solid #E2EBF0">
      <p style="font-size:11px;color:#8098A8;margin:0;line-height:1.7">
        Delivered by <strong style="color:#0A2A4A">Legacy Message</strong> · iFinallyWill.com<br>
        This message was written and sealed by ${name}.
      </p>
    </div>
  </div>
</body></html>`;
}

// ─── STATIC ASSETS (only from public/ subdir) ────
// Note: legacy_letter.html is served by the '/' route above
app.use(express.static(path.join(__dirname, 'public')));

// ─── START / EXPORT ───────────────────────────────
// Export the app for Vercel's serverless @vercel/node adapter.
// Only call app.listen() in local development (not on Vercel).
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\nLegacy Message running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
