require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { clerkMiddleware, requireAuth } = require('@clerk/express');

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

app.use(express.json({ limit: '10mb' }));

// Vercel serverless only allows writes to /tmp; fall back to local tmp/ in dev
const TMP_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'tmp');
const upload = multer({ dest: TMP_DIR });

// Clerk auth middleware — attaches auth state to every request
app.use(clerkMiddleware());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a compassionate writing coach helping people write meaningful legacy letters for their families. \
You understand that these messages will be read after the writer has passed, so they carry profound weight. \
You are warm, specific, and encouraging. You help people find the concrete details and honest feelings that make a message memorable. \
You never use clichés or generic advice. You speak directly to the writer, not about them. \
You MUST respond with valid JSON only, no markdown, no explanation outside the JSON: {"label": "...", "body": "..."}`;

const MODE_PROMPTS = {
  depth: (chapTitle, text) => `The user is writing a legacy letter chapter titled "${chapTitle}". Here is what they've written so far:\n\n"${text}"\n\nSuggest one specific detail, memory, or moment they could add to make this message more personal and memorable. Give them a concrete example they could adapt — not a vague direction. Return JSON: {"label": "A short 4-6 word title for your suggestion", "body": "One paragraph the user could add or adapt, written in a natural first-person voice"}`,

  tighten: (chapTitle, text) => `Here is a legacy letter passage from the chapter "${chapTitle}":\n\n"${text}"\n\nRewrite this to be more concise and emotionally direct. Cut the vague parts; keep the specific ones. Preserve the writer's voice — it should still sound like them. Return JSON: {"label": "A short label like \\"Tighter version\\"", "body": "The rewritten passage, keeping the same length or shorter"}`,

  check: (chapTitle, text) => `Read this legacy letter passage from the "${chapTitle}" chapter:\n\n"${text}"\n\nIdentify the core emotional theme. Then name one thing that feels unfinished or unsaid — something the writer might not have noticed they left out. Be gentle and specific. Return JSON: {"label": "A short 4-6 word observation label", "body": "1-2 sentences: what the message is really about, and what might still need saying"}`
};

const EMPTY_RESPONSES = {
  depth: { label: 'A way to begin', body: 'Start with one specific memory — a moment you can picture clearly. Even one concrete detail will pull the rest of the message with it. Where were you? Who was there? What did it smell or sound like?' },
  tighten: { label: 'Nothing to tighten yet', body: 'You haven\'t written anything yet. Add your message first, then come back and I\'ll help you sharpen it.' },
  check: { label: 'Start here', body: 'You haven\'t written anything yet. Try this: imagine the person who will hear this message. What is the one thing you most want them to know — something they might not already?' }
};

// ─── SERVE HTML WITH CLERK KEY INJECTED ──────────
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'legacy_letter.html'), 'utf8');
  const pk = process.env.CLERK_PUBLISHABLE_KEY || '';
  html = html.replace(
    '</head>',
    `<script>window.__CLERK_PK__="${pk}";</script>\n</head>`
  );
  res.type('html').send(html);
});

// ─── AI SUGGESTIONS (auth required) ─────────────
app.post('/api/suggest', requireAuth(), async (req, res) => {
  const { mode, text, chapId, chapTitle } = req.body;

  if (!text || text.trim().length < 10) {
    return res.json(EMPTY_RESPONSES[mode] || EMPTY_RESPONSES.depth);
  }

  const promptFn = MODE_PROMPTS[mode] || MODE_PROMPTS.depth;
  const userPrompt = promptFn(chapTitle || chapId || 'your chapter', text.trim());

  try {
    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: userPrompt }]
    });

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
app.post('/api/transcribe', requireAuth(), upload.single('audio'), async (req, res) => {
  const tmpPath = req.file ? req.file.path : null;

  if (!tmpPath) {
    return res.json({ text: '' });
  }

  if (!process.env.OPENAI_API_KEY) {
    cleanup(tmpPath);
    return res.json({ text: '', info: 'Set OPENAI_API_KEY to enable auto-transcription.' });
  }

  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const transcription = await openai.audio.transcriptions.create({
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

// ─── STATIC ASSETS (everything except index) ────
app.use(express.static(__dirname));

// ─── START ───────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nLegacy Message running at http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠  ANTHROPIC_API_KEY not set — AI suggestions will fail.');
  }
  if (!process.env.OPENAI_API_KEY) {
    console.log('ℹ  OPENAI_API_KEY not set — transcription disabled (users type manually).');
  }
});
