// ═══════════════════════════════════════════════
//  BUGBEAT — storage.js
//  Saved audio tracks in Cloudflare R2 (S3-compatible object storage).
//  Needs these environment variables (Render → Environment):
//    R2_ACCOUNT_ID         Cloudflare account ID
//    R2_ACCESS_KEY_ID      R2 API token: Access Key ID
//    R2_SECRET_ACCESS_KEY  R2 API token: Secret Access Key
//    R2_BUCKET             bucket name, e.g. bugbeat-audio
//  If any are missing, saving tracks is turned off (storageEnabled =
//  false) and the rest of the app works as before.
// ═══════════════════════════════════════════════
import 'dotenv/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3';

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_ENDPOINT          // optional override (local testing)
} = process.env;

export const storageEnabled = Boolean(
  R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && (R2_ACCOUNT_ID || R2_ENDPOINT)
);

const client = storageEnabled
  ? new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      forcePathStyle: true,
      // Only add checksums when an operation requires them (R2 recommends
      // this for the newer AWS SDK versions).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    })
  : null;

if (!storageEnabled) {
  console.warn('[storage] R2_* variables not set — saving audio tracks is disabled.');
}

export async function putObject(key, body, contentType) {
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: body.length
  }));
}

// Returns { body: Readable stream, contentLength, contentType }.
export async function getObject(key) {
  const out = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  return { body: out.Body, contentLength: out.ContentLength, contentType: out.ContentType };
}

export async function deleteObjects(keys) {
  const list = keys.filter(Boolean);
  // DeleteObjects takes up to 1000 keys per call.
  for (let i = 0; i < list.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: { Objects: list.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true }
    }));
  }
}

// Works out the real audio format from the file's first bytes, so only
// actual audio gets stored (the browser-supplied type and file name are
// not trusted). Returns { ext, mime } or null.
export function detectAudio(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (start, end) => buf.toString('latin1', start, end);
  if (ascii(0, 3) === 'ID3') return { ext: '.mp3', mime: 'audio/mpeg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { ext: '.wav', mime: 'audio/wav' };
  if (ascii(0, 4) === 'OggS') return { ext: '.ogg', mime: 'audio/ogg' };
  if (ascii(0, 4) === 'fLaC') return { ext: '.flac', mime: 'audio/flac' };
  if (ascii(4, 8) === 'ftyp') return { ext: '.m4a', mime: 'audio/mp4' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: '.webm', mime: 'audio/webm' };
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return { ext: '.aac', mime: 'audio/aac' };   // AAC (ADTS)
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { ext: '.mp3', mime: 'audio/mpeg' };  // MP3 frame
  return null;
}
