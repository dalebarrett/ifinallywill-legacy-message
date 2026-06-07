// ════════════════════════════════════════════════════════════════════════
// legacy-storage.js — media (audio/video/photo) storage + secure access
//
// Two backends, chosen automatically:
//   • S3 / Cloudflare R2  — when STORAGE_* env vars are set (production)
//   • Local filesystem    — dev fallback (./media), so it works on localhost
//
// Delivery never emails the file. The portal asks for a short-lived,
// authenticated URL (presigned for S3/R2, or a token-gated stream locally).
// ════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUCKET = process.env.STORAGE_BUCKET;
const REGION = process.env.STORAGE_REGION || 'auto';
const ENDPOINT = process.env.STORAGE_ENDPOINT; // R2: https://<acct>.r2.cloudflarestorage.com
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY_ID;
const SECRET_KEY = process.env.STORAGE_SECRET_ACCESS_KEY;

const useS3 = !!(BUCKET && ACCESS_KEY && SECRET_KEY);

// Local fallback dir (works on dev; Vercel /tmp is ephemeral, so prod needs S3)
const LOCAL_DIR = process.env.VERCEL ? '/tmp/media' : path.join(__dirname, 'media');

let _s3 = null;
function s3() {
  if (_s3) return _s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3 = new S3Client({
    region: REGION,
    endpoint: ENDPOINT || undefined,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    forcePathStyle: !!ENDPOINT, // required for R2 / MinIO
  });
  return _s3;
}

function isConfigured() {
  return useS3;
}
function backend() {
  return useS3 ? 's3' : 'local';
}

// Make a safe, namespaced object key.
function makeKey(ownerId, ext) {
  const safeExt = (ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  return `${ownerId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${safeExt}`;
}

async function putMedia(key, buffer, contentType) {
  if (useS3) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType || 'application/octet-stream' }));
    return { key, backend: 's3' };
  }
  // local
  const full = path.join(LOCAL_DIR, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  if (contentType) {
    try { fs.writeFileSync(full + '.type', contentType); } catch {}
  }
  return { key, backend: 'local' };
}

// For S3/R2: presigned GET URL the portal can redirect to.
// For local: returns null (caller streams via getLocal()).
async function getSignedUrl(key, ttlSeconds) {
  if (!useS3) return null;
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: ttlSeconds || 600 });
}

function getLocal(key) {
  const full = path.join(LOCAL_DIR, key);
  // Prevent path traversal
  if (!path.resolve(full).startsWith(path.resolve(LOCAL_DIR))) return null;
  if (!fs.existsSync(full)) return null;
  let contentType = 'application/octet-stream';
  try { contentType = fs.readFileSync(full + '.type', 'utf8'); } catch {}
  return { stream: fs.createReadStream(full), contentType };
}

module.exports = { isConfigured, backend, makeKey, putMedia, getSignedUrl, getLocal };
