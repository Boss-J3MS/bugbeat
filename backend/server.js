// ═══════════════════════════════════════════════
//  BUGBEAT — server.js
//  Endpoints:
//  POST /analyze      → Gemini code analysis
//  POST /music-search → Gemini music parameters
//  POST /complexity   → ML complexity analysis
//  POST /auth/signup  → Start sign-up: checks the email, emails a 6-digit code
//  POST /auth/signup/verify → Check the code and create the account
//  POST /auth/signup/resend → Email a new code
//  POST /auth/login   → Login + get JWT token
//  POST /auth/google  → Login/signup via Google
//  GET  /auth/me      → Get current user info
//  POST /auth/change-password → Change (or set) password while logged in
//  POST /auth/admin-invite/check  → Is an admin invite link still usable?
//  POST /auth/admin-invite/accept → Logged-in user accepts an admin invite
//  GET/POST /admin/invites, DELETE /admin/invites/:id → Manage invite links
//  POST /auth/forgot-password → Email a password reset link
//  POST /auth/reset-password  → Set a new password from a reset link
//  POST /history/save → Save analysis to DB
//  GET  /history      → Get user's analysis history
//  GET  /history/:id  → Recall full session
//  POST /audio/upload → Save audio upload metadata
//  GET  /audio        → Get user audio uploads
//  GET  /notifications       → Get notifications
//  PATCH /notifications/:id/read → Mark as read
//  PATCH /notifications/read-all → Mark all as read
// ═══════════════════════════════════════════════

import express     from 'express';
import cors        from 'cors';
import dotenv       from 'dotenv';
import helmet        from 'helmet';
import rateLimit       from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import crypto       from 'crypto';
import dns          from 'dns';
import db       from './db.js';
import { hashPassword, verifyPassword, generateToken, requireAuth, requireAdmin, validatePasswordStrength } from './auth.js';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

// Google sign-in is optional — the rest of the app works fine without it,
// so this warns rather than exits like the JWT_SECRET check does. Without
// GOOGLE_CLIENT_ID set, /auth/google just responds 503 instead of the
// server refusing to start.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
if (!GOOGLE_CLIENT_ID) {
  console.warn('[auth] GOOGLE_CLIENT_ID is not set — /auth/google will be unavailable.');
}
// Locally this is the Python FastAPI service on your machine; once deployed,
// set ML_SERVICE_URL to wherever it actually lives (e.g. a Hugging Face
// Space) — otherwise the deployed backend will try to reach its own
// container on port 5000, where nothing is listening.
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:5000';

// Render (and most hosts) sit their app behind a reverse proxy, which sets
// X-Forwarded-For to the real client IP. Without telling Express to trust
// that one hop, express-rate-limit can't tell who's making requests and
// throws on every single request (breaking EVERYTHING, not just rate
// limiting) as a safety check against IP spoofing. '1' = trust exactly one
// hop of proxy, which matches Render's setup; locally there's no proxy in
// front, so this has no effect on your own machine.
app.set('trust proxy', 1);

// Security headers (CSP is left to defaults off since the frontend is a
// separate static site on a different origin — this backend serves JSON only).
app.use(helmet());

// The app deals with source code snippets and JSON payloads, not large file
// uploads (audio uploads currently only send metadata) — 50mb was far more
// than anything legitimate needs and made a body-size DoS trivially cheap.
app.use(express.json({ limit: '2mb' }));

// General API rate limit — generous enough for normal use, but stops
// trivial scripted abuse. Auth routes get a much stricter limit below
// since credential stuffing / signup spam is the higher-value target.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a while before trying again.' },
});

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  }
}));

// ── Helper: call Gemini ────────────────────────
async function callGemini(apiKey, prompt, temperature = 0.1) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
          // Gemini 2.5 Flash spends an internal "thinking" budget by
          // default, even on tasks that don't need multi-step reasoning —
          // for a few seconds. Classifying each line's severity is exactly
          // that kind of task, so turning thinking off cuts a meaningful
          // chunk off every /analyze and /music-search call.
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini error (HTTP ${res.status})`);
  }
  const data    = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Gemini returned an empty response.');
  return rawText.replace(/```json|```/g, '').trim();
}

// ── Helper: look up a song's REAL tempo/key via GetSongBPM ────
// Gemini is asked to "recall" a song's actual BPM from memory, which it
// frequently gets wrong or invents outright. GetSongBPM.com's database
// gives us a verified tempo (and key) to use as a hard anchor instead of
// trusting the model's memory. Returns null on no match / no API key /
// any failure — the caller falls back to Gemini's own guess.
async function lookupRealBPM(query) {
  const apiKey = process.env.GETSONGBPM_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://api.getsong.co/search/?api_key=${apiKey}&type=song&lookup=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data    = await res.json();
    const results = data?.search;
    if (!Array.isArray(results) || !results.length) return null;
    const top = results[0];
    const tempo = Number(top.tempo);
    if (!Number.isFinite(tempo)) return null;
    return {
      title:  top.title || query,
      artist: top.artist?.name || '',
      tempo,
      key:    top.key_of || null
    };
  } catch (err) {
    console.error('GetSongBPM lookup failed:', err.message);
    return null;
  }
}

// ── Helper: sanitize a Gemini-generated music style ────────────
// Gemini doesn't always follow the requested schema/ranges exactly.
// Tone.js throws on bad values (e.g. an unknown oscillator type), which
// can kill playback mid-song. Clamp/validate everything before it
// ever reaches the frontend.
const VALID_OSCILLATORS = new Set(['sine', 'triangle', 'sawtooth', 'square']);
const VALID_NOISE_TYPES = new Set(['white', 'pink', 'brown']);

function clampNum(val, min, max, fallback) {
  const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.min(max, Math.max(min, n));
}

// Tone.js needs exact note syntax: a pitch class A-G, an optional sharp/flat
// (# or b, once or twice), then an octave number. Anything else (lowercase
// "c4", unicode flat "♭", missing octave, etc.) throws — and since every
// triggerAttackRelease call is wrapped in a silent try/catch, a bad note
// doesn't crash the app, it just drops that beat, sounding like the music
// randomly cuts in and out.
const NOTE_RE = /^[A-G](#{1,2}|b{1,2})?-?\d+$/;

function isValidNote(n) {
  return typeof n === 'string' && NOTE_RE.test(n.trim());
}

function sanitizeNotes(arr, fallback) {
  return Array.isArray(arr) && arr.length && arr.every(isValidNote) ? arr : fallback;
}

function sanitizeChords(arr, fallback) {
  return Array.isArray(arr) && arr.length &&
    arr.every(c => Array.isArray(c) && c.length && c.every(isValidNote))
    ? arr : fallback;
}

function sanitizeBeatArray(arr, fallback) {
  return Array.isArray(arr) && arr.length === fallback.length ? arr : fallback;
}

// Asking an LLM to freehand-compose a 16-step kick/snare/hihat pattern from
// scratch turns out to be unreliable: across dozens of test searches
// spanning several genres, Gemini kept returning the exact same generic
// four-on-the-floor pattern regardless of the requested style, even when the
// prompt explicitly told it to vary the rhythm. Composing novel binary step
// sequences isn't something language models do reliably — they regress to
// the most common/"safe" pattern. Instead, Gemini only has to pick a genre
// TAG (something LLMs are very reliable at), and the actual 16-step arrays
// come from these hand-written, genuinely genre-distinct presets. A couple
// of genres carry more than one variant so repeat searches in the same
// genre don't feel identical either.
const RHYTHM_PRESETS = {
  four_on_floor: [ // house / EDM / dance-pop
    { kick: [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1], openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
    { kick: [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], openHat: [0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0] }
  ],
  one_drop_reggae: [ // reggae / dub — kick+snare together on beat 3, nothing on beat 1
    { kick: [0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], snare: [0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], hihat: [0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0], openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] }
  ],
  trap: [ // trap / modern hip-hop — sparse syncopated kick, backbeat clap, rolling hats
    { kick: [1,0,0,1,0,0,1,0,0,0,1,0,0,0,0,0], snare: [0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], hihat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], openHat: [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0] }
  ],
  boom_bap: [ // 90s hip-hop — laid-back kick/snare, steady 8th hats
    { kick: [1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
    { kick: [1,0,0,1,0,0,0,0,0,0,1,0,0,1,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] }
  ],
  rock_driving: [ // rock / punk / pop-rock — driving 8th-note kick
    { kick: [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] }
  ],
  ballad_sparse: [ // slow ballad / acoustic — mostly empty, gentle pulse
    { kick: [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], snare: [0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], hihat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] }
  ],
  swing_jazz: [ // jazz / lo-fi — swung, sparse brushes
    { kick: [1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1], openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] }
  ],
  disco_funk: [ // disco / funk — busy hats, open hat on the offbeats
    { kick: [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], openHat: [0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0] }
  ]
};

function pickRhythmPattern(rhythmFeel) {
  const variants = RHYTHM_PRESETS[rhythmFeel] || RHYTHM_PRESETS.four_on_floor;
  const chosen   = variants[Math.floor(Math.random() * variants.length)];
  return {
    kick:    [...chosen.kick],
    snare:   [...chosen.snare],
    hihat:   [...chosen.hihat],
    openHat: [...chosen.openHat]
  };
}

function sanitizeStyle(raw = {}) {
  const FALLBACK = {
    scale: ['C3','Eb3','F3','G3','Bb3','C4','Eb4','F4','G4','Bb4'],
    chordProgression: [['C4','Eb4','G4'],['Bb3','D4','F4'],['Ab3','C4','Eb4'],['G3','B3','D4']],
    bassLine: ['C2','C2','Bb1','Bb1','Ab1','Ab1','G1','G1'],
    padChords: [['C4','Eb4','G4'],['Bb3','D4','F4'],['Ab3','C4','Eb4'],['G3','Bb3','D4']],
    leadNotes: ['G4','Bb4','C5','Eb5','F5','G5','Bb5','C6'],
    envelope: { attack: 0.05, decay: 0.3, sustain: 0.4, release: 0.8 },
    drumKit: {
      kickPitchDecay: 0.06,
      kickOctaves: 8,
      snareNoiseType: 'white',
      hihatFrequency: 400,
      hihatDecay: 0.04
    }
  };

  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Generated Style',
    description: typeof raw.description === 'string' ? raw.description : '',
    bpm: Math.round(clampNum(raw.bpm, 60, 180, 90)),
    oscillatorType: VALID_OSCILLATORS.has(raw.oscillatorType) ? raw.oscillatorType : 'triangle',
    scale: sanitizeNotes(raw.scale, FALLBACK.scale),
    chordProgression: sanitizeChords(raw.chordProgression, FALLBACK.chordProgression),
    bassLine: sanitizeNotes(raw.bassLine, FALLBACK.bassLine),
    padChords: sanitizeChords(raw.padChords, FALLBACK.padChords),
    leadNotes: sanitizeNotes(raw.leadNotes, FALLBACK.leadNotes),
    chordMap: {
      clean:    sanitizeNotes(raw.chordMap?.clean,    ['C4','G4']),
      warning:  sanitizeNotes(raw.chordMap?.warning,  ['Bb3','F4']),
      error:    sanitizeNotes(raw.chordMap?.error,    ['Eb3','Bb3']),
      critical: sanitizeNotes(raw.chordMap?.critical, ['C3','Gb3'])
    },
    envelope: {
      attack:  clampNum(raw.envelope?.attack,  0, 2, FALLBACK.envelope.attack),
      decay:   clampNum(raw.envelope?.decay,   0, 2, FALLBACK.envelope.decay),
      sustain: clampNum(raw.envelope?.sustain, 0, 1, FALLBACK.envelope.sustain),
      release: clampNum(raw.envelope?.release, 0, 3, FALLBACK.envelope.release)
    },
    reverbWet: clampNum(raw.reverbWet, 0, 1, 0.4),
    chorusWet: clampNum(raw.chorusWet, 0, 1, 0.2),
    volume: clampNum(raw.volume, -30, -4, -14),
    // Gemini picks the genre TAG (rhythmFeel); the actual 16-step
    // kick/snare/hihat/openHat arrays come from our own hand-written,
    // genuinely genre-distinct presets — see RHYTHM_PRESETS above for why.
    rhythmFeel: RHYTHM_PRESETS[raw.rhythmFeel] ? raw.rhythmFeel : 'four_on_floor',
    loopPattern: pickRhythmPattern(raw.rhythmFeel),
    drumKit: {
      kickPitchDecay: clampNum(raw.drumKit?.kickPitchDecay, 0.02, 0.15, FALLBACK.drumKit.kickPitchDecay),
      kickOctaves:    clampNum(raw.drumKit?.kickOctaves, 4, 10, FALLBACK.drumKit.kickOctaves),
      snareNoiseType: VALID_NOISE_TYPES.has(raw.drumKit?.snareNoiseType) ? raw.drumKit.snareNoiseType : FALLBACK.drumKit.snareNoiseType,
      hihatFrequency: clampNum(raw.drumKit?.hihatFrequency, 200, 800, FALLBACK.drumKit.hihatFrequency),
      hihatDecay:     clampNum(raw.drumKit?.hihatDecay, 0.01, 0.2, FALLBACK.drumKit.hihatDecay)
    }
  };
}

// ── Health check ───────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'BugBeat API' });
});

// ── POST /complexity ───────────────────────────
app.post('/complexity', async (req, res) => {
  const { code, lang = 'auto', use_codebert = true } = req.body;
  if (!code || !code.trim()) {
    return res.status(400).json({ error: 'Missing or empty "code" field.' });
  }
  try {
    const mlRes = await fetch(`${ML_SERVICE_URL}/complexity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, lang, use_codebert })
    });
    if (!mlRes.ok) {
      const err = await mlRes.json().catch(() => ({}));
      return res.status(502).json({ error: err.detail || 'ML service error.' });
    }
    const data = await mlRes.json();
    res.json(data);
  } catch(err) {
    console.error('ML service unreachable:', err.message);
    res.status(503).json({ error: 'ML service is not running. Start it with: python main.py' });
  }
});

// ── POST /analyze ──────────────────────────────
app.post('/analyze', async (req, res) => {
  const { code, lang = 'auto' } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: 'Missing or empty "code" field.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfiguration: API key missing.' });

  const langLabel  = lang === 'auto' ? '' : `${lang} `;
  const totalLines = code.split('\n').length;

  const prompt = `You are a code analysis engine. Analyze every line of the following ${langLabel}code.

For EACH line, identify:
- Syntax errors
- Logic bugs (wrong operators, off-by-one, incorrect conditions)
- Runtime risks (null/undefined access, index out of bounds)
- Bad practices or code smells (unused variables, missing semicolons, etc.)
- Missing error handling or security issues

Return ONLY a valid JSON object. No markdown, no backticks, no explanation.

Format:
{
  "lines": [
    { "line": 1, "severity": "clean", "message": "" },
    { "line": 2, "severity": "warning", "message": "Missing semicolon" },
    { "line": 3, "severity": "error", "message": "Off-by-one: use i < items.length" },
    { "line": 4, "severity": "critical", "message": "Null dereference risk" }
  ]
}

Severity: "clean" | "warning" | "error" | "critical"
MUST include every single line from 1 to ${totalLines}.

${langLabel}Code:
\`\`\`
${code}
\`\`\``;

  try {
    const text   = await callGemini(apiKey, prompt, 0.1);
    const parsed = JSON.parse(text);
    const lines  = parsed?.lines;
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(502).json({ error: 'Gemini returned no line data.' });
    }
    const valid = new Set(['clean','warning','error','critical']);
    res.json({
      lines: lines.map(l => ({
        line:     typeof l.line === 'number' ? l.line : 0,
        severity: valid.has(l.severity) ? l.severity : 'clean',
        message:  typeof l.message === 'string' ? l.message : ''
      }))
    });
  } catch (err) {
    console.error('/analyze error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── POST /music-search ─────────────────────────
app.post('/music-search', async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'Missing or empty "query" field.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfiguration: API key missing.' });

  // Try to find the song in a real music database first, so Gemini gets a
  // verified tempo/key to anchor to instead of relying on its own memory.
  const realSong = await lookupRealBPM(query);

  const prompt = `You are a music parameter engine for a web app called BugBeat that turns code errors into music.

The user searched for a music style or song: "${query}"
${realSong ? `
VERIFIED DATABASE MATCH — treat this as ground truth, not a suggestion:
"${realSong.title}"${realSong.artist ? ` by ${realSong.artist}` : ''} has a real, measured tempo of
${realSong.tempo} BPM${realSong.key ? ` and is in the key of ${realSong.key}` : ''}. You MUST set
"bpm" to exactly ${realSong.tempo} in your JSON response. Use this verified tempo${realSong.key ? ' and key' : ''}
as the anchor for everything else you generate below.
` : ''}
If "${query}" sounds like a real song title or artist you recognize, recall its ACTUAL known
characteristics as accurately as you can and use them as hard anchors, not loose suggestions:
- its real approximate BPM/tempo${realSong ? ' (already given above — use that exact value)' : ''}
- its real key or scale (major/minor, and roughly which key)
- its real genre and era (e.g. 2010s OPM pop-rock, 2020s future bass, 90s boom-bap)
- its real typical instrumentation and production texture (e.g. acoustic guitar-driven, 808-heavy,
  synth-pad-washed, live-drum-kit-driven)
Getting the tempo, key, and genre right is what will make this actually feel like the searched song —
prioritize accuracy on those four anchors above everything else below.

Within those anchors, generate an ORIGINAL melody, chord voicing, and rhythm pattern idiomatic to that
exact genre/era/instrumentation — do NOT attempt to reproduce the song's actual copyrighted melody,
lyrics, or exact chord-for-chord progression; you likely don't remember it precisely anyway, and BugBeat
only needs something that captures the song's tempo/key/genre/texture, not a cover of it.

If "${query}" is not a recognizable song/artist (e.g. a mood or genre description), just design an
original style matching that description directly.

Return ONLY a valid JSON object. No markdown, no backticks, no explanation.

The JSON below shows the REQUIRED STRUCTURE ONLY — every value in it, especially "leadNotes", is a
placeholder. Do NOT copy these literal example values into your answer. Every field must be freshly
generated to match THIS specific song/style's genre and mood, and two different queries must never
produce the same leadNotes.

{
  "name": "Short descriptive name of the generated style (e.g. 'Dark Jazz Inspired', 'Upbeat Pop Vibe')",
  "description": "One sentence describing the musical feel",
  "bpm": 90,
  "oscillatorType": "triangle",
  "scale": ["C3","Eb3","F3","G3","Bb3","C4","Eb4","F4","G4","Bb4"],
  "chordProgression": [
    ["C4","Eb4","G4"],
    ["Bb3","D4","F4"],
    ["Ab3","C4","Eb4"],
    ["G3","B3","D4"]
  ],
  "bassLine": ["C2","C2","Bb1","Bb1","Ab1","Ab1","G1","G1"],
  "padChords": [
    ["C4","Eb4","G4"],
    ["Bb3","D4","F4"],
    ["Ab3","C4","Eb4"],
    ["G3","Bb3","D4"]
  ],
  "leadNotes": ["G4","Bb4","C5","Eb5","F5","G5","Bb5","C6"],
  "chordMap": {
    "clean":    ["C4","G4"],
    "warning":  ["Bb3","F4"],
    "error":    ["Eb3","Bb3"],
    "critical": ["C3","Gb3"]
  },
  "envelope": {
    "attack": 0.05,
    "decay": 0.3,
    "sustain": 0.4,
    "release": 0.8
  },
  "reverbWet": 0.4,
  "chorusWet": 0.2,
  "volume": -14,
  "rhythmFeel": "four_on_floor",
  "drumKit": {
    "kickPitchDecay": 0.06,
    "kickOctaves": 8,
    "snareNoiseType": "white",
    "hihatFrequency": 400,
    "hihatDecay": 0.04
  }
}

Rules:
- BPM between 60 and 180
- oscillatorType: "sine" | "triangle" | "sawtooth" | "square" — this tone color is shared by the bass, pads, lead AND melody, so pick it to match the overall style (e.g. "sine" for soft/chill, "sawtooth" for aggressive/energetic)
- Scale must have 8-12 notes
- bassLine must have 6-8 notes, in a low register (octaves 1-2), matching the style's mood
- padChords must have 4 chords, each a 3-note array, matching the style's mood
- leadNotes must have 6-8 notes, in a higher register (octaves 4-6), matching the style's mood — this is
  a melodic PHRASE with its own contour (skips, repeats, direction changes), not a plain ascending or
  descending scale run; it should sound distinct from the leadNotes of a differently-styled song
- chordMap must have all four keys: clean, warning, error, critical
- drumKit.kickPitchDecay: 0.02-0.15 (lower = tighter/punchier kick, higher = deeper/boomier kick)
- drumKit.kickOctaves: 4-10 (higher = more pitch sweep/punch)
- drumKit.snareNoiseType: "white" | "pink" | "brown" (white = crisp/pop, pink = warmer, brown = deep/soft)
- drumKit.hihatFrequency: 200-800 (higher = brighter/crisper hi-hat, lower = darker/duller)
- drumKit.hihatDecay: 0.01-0.2 (lower = tighter/closed, higher = looser/open feel)
- rhythmFeel: pick the ONE tag below that best matches this song/style's actual drum-pattern feel — this
  choice matters more than almost anything else here, since it's the main thing that will make the beat
  actually sound like the right genre instead of generic pop:
  "four_on_floor"    — house / EDM / dance-pop / most upbeat mainstream pop
  "one_drop_reggae"  — reggae / dub
  "trap"             — trap / modern hip-hop / drill
  "boom_bap"         — 90s-2000s hip-hop / OPM hip-hop
  "rock_driving"     — rock / punk / pop-rock / metal
  "ballad_sparse"    — slow ballads, acoustic, sad/soft songs
  "swing_jazz"       — jazz, lo-fi, swing, bossa nova
  "disco_funk"       — disco, funk, soul`;

  try {
    const text   = await callGemini(apiKey, prompt, 0.7);
    const parsed = JSON.parse(text);
    const style  = sanitizeStyle(parsed);
    // Belt-and-suspenders: force the verified tempo even if Gemini didn't
    // follow the instruction exactly.
    if (realSong) style.bpm = Math.round(clampNum(realSong.tempo, 60, 180, style.bpm));
    res.json({ style, matchedSong: realSong ? { title: realSong.title, artist: realSong.artist, tempo: realSong.tempo } : null });
  } catch (err) {
    console.error('/music-search error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════

// ── Sign-up with email verification ────────────
// Sign-up happens in two steps so made-up emails never become accounts:
//   1. POST /auth/signup         checks the details and the email's domain,
//                                saves a pending sign-up, emails a 6-digit code
//   2. POST /auth/signup/verify  checks the code, then creates the account
// Pending sign-ups live in email_verifications (not users) until verified.
const SIGNUP_CODE_MINUTES      = 10;
const SIGNUP_CODE_MAX_ATTEMPTS = 5;
const SIGNUP_RESEND_SECONDS    = 60;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,20}$/;
const EMAIL_PATTERN    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Common throwaway-inbox services. Not exhaustive: the emailed code is the
// real check; this just turns away the most obvious ones up front.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'guerrillamail.net',
  'sharklasers.com', 'grr.la', '10minutemail.com', '10minutemail.net', 'tempmail.com',
  'temp-mail.org', 'temp-mail.io', 'tempmailo.com', 'tempr.email', 'yopmail.com',
  'yopmail.net', 'trashmail.com', 'getnada.com', 'nada.email', 'dispostable.com',
  'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com',
  'emailondeck.com', 'moakt.com', 'spamgourmet.com', 'mailnesia.com', 'mytemp.email',
  '1secmail.com', '1secmail.org', '1secmail.net', 'burnermail.io', 'discard.email',
  'fakemail.net', 'mailcatch.com', 'inboxkitten.com', 'getairmail.com', 'mail.tm',
  'emailfake.com', 'tmpmail.org', 'tmpmail.net', 'minuteinbox.com', 'mailpoof.com'
]);

const dnsResolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });

// Can this email's domain receive mail at all? Rejects made-up domains
// (e.g. @asdfqwer.com). Returns { ok, reason }. If DNS itself is having
// trouble, lets the address through; the emailed code still has to arrive.
async function checkEmailDomain(email) {
  const domain = email.split('@').pop().toLowerCase();
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return { ok: false, reason: 'Temporary / disposable email addresses are not allowed. Please use your real email.' };
  }
  try {
    const records = await dnsResolver.resolveMx(domain);
    // A "null MX" (single record with an empty exchange) means "this domain
    // accepts no email".
    const usable = records.filter((r) => r.exchange && r.exchange !== '.');
    if (usable.length > 0) return { ok: true };
    return { ok: false, reason: `The email domain "${domain}" can't receive email. Please check the address.` };
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'NXDOMAIN') {
      return { ok: false, reason: `The email domain "${domain}" doesn't exist or can't receive email. Please check the address.` };
    }
    console.warn(`[auth] MX lookup for ${domain} failed (${err.code || err.message}); allowing sign-up to continue`);
    return { ok: true };
  }
}

function makeSignupCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// The code is stored hashed (with the email mixed in), never as-is.
function hashSignupCode(email, code) {
  return crypto.createHash('sha256').update(`${email.toLowerCase()}:${code}`).digest('hex');
}

// Stricter than authLimiter: every call sends an email.
const emailCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification emails requested. Please wait a while before trying again.' },
});

// ── POST /auth/signup ──────────────────────────
// Step 1: validate, check the email, save a pending sign-up, email a code.
app.post('/auth/signup', emailCodeLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const email    = String(req.body?.email || '').trim();
  const password = req.body?.password;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Restrict usernames to a safe character set so stored values can never
  // break out of HTML/JS when rendered elsewhere (e.g. the admin panel).
  // Letters, numbers, underscore, hyphen, period — 3 to 20 characters.
  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3-20 characters and can only contain letters, numbers, underscores, hyphens, and periods.'
    });
  }

  // Basic email format check + length cap (defense in depth, not a full RFC validator)
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.valid) {
    return res.status(400).json({ error: passwordCheck.error });
  }

  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    return res.status(503).json({ error: 'Sign-up email verification is not set up on this server yet.' });
  }

  try {
    const [existing] = await db.query(
      'SELECT id FROM users WHERE email = ? OR username = ?',
      [email, username]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email or username already in use.' });
    }

    const domainCheck = await checkEmailDomain(email);
    if (!domainCheck.ok) {
      return res.status(400).json({ error: domainCheck.reason });
    }

    // Starting again with the same email replaces the earlier pending sign-up.
    const code = makeSignupCode();
    const hash = await hashPassword(password);
    await db.query('DELETE FROM email_verifications WHERE email = ?', [email]);
    await db.query(
      `INSERT INTO email_verifications (email, username, password_hash, code_hash, expires_at, last_sent_at)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), NOW())`,
      [email, username, hash, hashSignupCode(email, code), SIGNUP_CODE_MINUTES]
    );

    await sendSignupCodeEmail(email, username, code);

    res.status(202).json({
      verificationRequired: true,
      email,
      message: `We sent a 6-digit code to ${email}. Enter it below to finish creating your account.`
    });
  } catch (err) {
    console.error('/auth/signup error:', err.message);
    res.status(500).json({ error: 'Could not send the verification email. Please check the address and try again.' });
  }
});

// ── POST /auth/signup/verify ───────────────────
// Step 2: check the code and create the account.
app.post('/auth/signup/verify', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const code  = String(req.body?.code || '').replace(/\s+/g, '');
  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Please enter the 6-digit code from the email.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, email, username, password_hash, code_hash, attempts, (expires_at > NOW()) AS still_valid
         FROM email_verifications WHERE email = ? LIMIT 1`,
      [email]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No sign-up is waiting for this email. Please fill in the form again.' });
    }
    const pending = rows[0];

    if (!pending.still_valid) {
      return res.status(400).json({ error: 'This code has expired. Click "Resend code" to get a new one.', expired: true });
    }
    if (pending.attempts >= SIGNUP_CODE_MAX_ATTEMPTS) {
      return res.status(400).json({ error: 'Too many wrong codes. Click "Resend code" to get a new one.', expired: true });
    }

    const given = Buffer.from(hashSignupCode(email, code), 'hex');
    const saved = Buffer.from(pending.code_hash, 'hex');
    if (given.length !== saved.length || !crypto.timingSafeEqual(given, saved)) {
      await db.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?', [pending.id]);
      const left = SIGNUP_CODE_MAX_ATTEMPTS - pending.attempts - 1;
      return res.status(400).json({
        error: left > 0
          ? `That code is incorrect. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'That code is incorrect. Click "Resend code" to get a new one.',
        expired: left <= 0
      });
    }

    // Someone may have taken the username/email while this was pending.
    const [taken] = await db.query(
      'SELECT id FROM users WHERE email = ? OR username = ?',
      [pending.email, pending.username]
    );
    if (taken.length > 0) {
      await db.query('DELETE FROM email_verifications WHERE id = ?', [pending.id]);
      return res.status(409).json({ error: 'Email or username already in use. Please sign up again with a different one.' });
    }

    const [newUser] = await db.query(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [pending.username, pending.email, pending.password_hash, 'user']
    );
    await db.query('DELETE FROM email_verifications WHERE id = ?', [pending.id]);

    const token = generateToken({
      userId   : newUser.insertId,
      email    : pending.email,
      username : pending.username,
      role     : 'user'
    });

    const signupExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO sessions (user_id, token, ip_address, device_info, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [newUser.insertId, token, req.ip || '', req.headers['user-agent'] || '', signupExpiry]
    );

    await db.query(
      `INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)`,
      [newUser.insertId, 'Welcome to BugBeat! Submit your first code analysis to get started.', 'system']
    );

    res.status(201).json({
      message : 'Account created successfully!',
      token,
      user    : { id: newUser.insertId, username: pending.username, email: pending.email, role: 'user' }
    });
  } catch (err) {
    console.error('/auth/signup/verify error:', err.message);
    res.status(500).json({ error: 'Could not verify the code. Please try again.' });
  }
});

// ── POST /auth/signup/resend ───────────────────
// Emails a new code for a pending sign-up (at most once a minute).
app.post('/auth/signup/resend', emailCodeLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!email) {
    return res.status(400).json({ error: 'Missing email.' });
  }
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    return res.status(503).json({ error: 'Sign-up email verification is not set up on this server yet.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, username, TIMESTAMPDIFF(SECOND, last_sent_at, NOW()) AS since_sent
         FROM email_verifications WHERE email = ? LIMIT 1`,
      [email]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No sign-up is waiting for this email. Please fill in the form again.' });
    }
    const pending = rows[0];
    if (pending.since_sent < SIGNUP_RESEND_SECONDS) {
      const wait = SIGNUP_RESEND_SECONDS - pending.since_sent;
      return res.status(429).json({ error: `Please wait ${wait} seconds before requesting another code.`, retryAfter: wait });
    }

    const code = makeSignupCode();
    await db.query(
      `UPDATE email_verifications
          SET code_hash = ?, attempts = 0, expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE), last_sent_at = NOW()
        WHERE id = ?`,
      [hashSignupCode(email, code), SIGNUP_CODE_MINUTES, pending.id]
    );
    await sendSignupCodeEmail(email, pending.username, code);

    res.json({ message: `We sent a new code to ${email}.` });
  } catch (err) {
    console.error('/auth/signup/resend error:', err.message);
    res.status(500).json({ error: 'Could not send a new code. Please try again.' });
  }
});

// ── POST /auth/login ───────────────────────────
app.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const [rows] = await db.query(
      'SELECT id, username, email, password_hash, role FROM users WHERE email = ?',
      [email]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];

    // Accounts created via Google sign-in have no password_hash — bcrypt
    // can't compare against null, so catch this before calling it and give
    // a clearer message than a generic failure.
    if (!user.password_hash) {
      return res.status(401).json({ error: 'This account uses Google sign-in. Please continue with Google instead.' });
    }

    const match = await verifyPassword(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Generate token
    const token = generateToken({
      userId   : user.id,
      email    : user.email,
      username : user.username,
      role     : user.role
    });

    // Save session
    const loginExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO sessions (user_id, token, ip_address, device_info, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        user.id,
        token,
        req.ip || '',
        req.headers['user-agent'] || '',
        loginExpiry
      ]
    );

    // Update last_login
    await db.query(
      'UPDATE users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    res.json({
      message : 'Login successful!',
      token,
      user    : { id: user.id, username: user.username, email: user.email, role: user.role }
    });

  } catch (err) {
    console.error('/auth/login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── POST /auth/google ───────────────────────────
// Accepts the ID token Google's Identity Services library hands the
// frontend after a successful "Continue with Google" flow. Verifies it
// with Google (signature, expiry, audience === our client ID — this is
// what actually proves the token wasn't forged), then either links it to
// an existing password-based account with the same email, or creates a
// new Google-only account (password_hash left NULL). Either way it issues
// the same kind of session/JWT as regular login, so nothing downstream
// needs to know which path a user came in through.
app.post('/auth/google', authLimiter, async (req, res) => {
  if (!googleClient) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  }

  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential.' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    payload = ticket.getPayload();
  } catch (err) {
    console.error('/auth/google verify error:', err.message);
    return res.status(401).json({ error: 'Invalid Google credential.' });
  }

  if (!payload?.email) {
    return res.status(400).json({ error: 'Your Google account has no email to sign in with.' });
  }
  if (payload.email_verified === false) {
    return res.status(403).json({ error: 'Your Google email address is not verified.' });
  }

  const googleId = payload.sub;
  const email    = payload.email;

  try {
    let [rows] = await db.query(
      'SELECT id, username, email, role, password_hash FROM users WHERE google_id = ? LIMIT 1',
      [googleId]
    );

    let user;
    if (rows.length > 0) {
      user = rows[0];
    } else {
      [rows] = await db.query(
        'SELECT id, username, email, role, password_hash FROM users WHERE email = ? LIMIT 1',
        [email]
      );

      if (rows.length > 0) {
        // Existing password-based account, same email — link it rather
        // than creating a duplicate.
        user = rows[0];
        await db.query('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
      } else {
        // First time this email has signed in at all. Derive a username
        // from the email's local part, sanitized to the same rules
        // /auth/signup enforces, with a numeric suffix if it collides.
        const rawBase = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '');
        const base    = (rawBase.slice(0, 17) || 'user').padEnd(3, '0');
        let username  = base;
        for (let attempt = 1; attempt <= 10; attempt++) {
          const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
          if (existing.length === 0) break;
          const suffix = `_${attempt}`;
          username = `${base.slice(0, 20 - suffix.length)}${suffix}`;
        }

        const [newUser] = await db.query(
          'INSERT INTO users (username, email, password_hash, role, google_id) VALUES (?, ?, NULL, ?, ?)',
          [username, email, 'user', googleId]
        );
        user = { id: newUser.insertId, username, email, role: 'user' };

        await db.query(
          `INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)`,
          [user.id, 'Welcome to BugBeat! Submit your first code analysis to get started.', 'system']
        );
      }
    }

    const token = generateToken({
      userId   : user.id,
      email    : user.email,
      username : user.username,
      role     : user.role
    });

    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO sessions (user_id, token, ip_address, device_info, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [user.id, token, req.ip || '', req.headers['user-agent'] || '', expiry]
    );

    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    res.json({
      message: 'Login successful!',
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role }
    });

  } catch (err) {
    console.error('/auth/google error:', err.message);
    res.status(500).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

// ── GET /auth/me ───────────────────────────────
app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, email, role, created_at, last_login, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = ?',
      [req.user.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = { ...rows[0], has_password: !!rows[0].has_password };
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch user info.' });
  }
});

// ── POST /auth/logout ──────────────────────────
app.post('/auth/logout', requireAuth, async (req, res) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    if (token) {
      await db.query('DELETE FROM sessions WHERE token = ?', [token]);
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    console.error('/auth/logout error:', err.message);
    res.status(500).json({ error: 'Logout failed.' });
  }
});

// ══════════════════════════════════════════════
// PASSWORD ROUTES
// ══════════════════════════════════════════════

// ── POST /auth/change-password ─────────────────
// Logged-in user changes their password. Accounts created through Google
// sign-in have no password yet: for those, currentPassword is not needed
// and this sets their first password (they can then also log in with
// email + password). Logs the account out everywhere except this session.
app.post('/auth/change-password', requireAuth, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return res.status(400).json({ error: strength.error });
  }

  try {
    const [rows] = await db.query(
      'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
      [req.user.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const currentHash = rows[0].password_hash;

    if (currentHash) {
      if (typeof currentPassword !== 'string' || currentPassword === '') {
        return res.status(400).json({ error: 'Please enter your current password.' });
      }
      // 400, not 401: the frontend treats 401 as "your session is over".
      if (!(await verifyPassword(currentPassword, currentHash))) {
        return res.status(400).json({ error: 'Your current password is incorrect.' });
      }
      if (await verifyPassword(newPassword, currentHash)) {
        return res.status(400).json({ error: 'Your new password must be different from your current one.' });
      }
    }

    const newHash = await hashPassword(newPassword);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.userId]);

    // Sign out other devices; keep the session that made this change.
    const token = req.headers['authorization'].split(' ')[1];
    await db.query('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [req.user.userId, token]);

    res.json({
      message: currentHash
        ? 'Password changed. Other devices have been logged out.'
        : 'Password set. You can now also log in with your email and password.'
    });
  } catch (err) {
    console.error('/auth/change-password error:', err.message);
    res.status(500).json({ error: 'Could not change your password. Please try again.' });
  }
});

// ── Password reset by email ────────────────────
// Emails go through Brevo's HTTP API. Render's free tier blocks outbound
// SMTP ports (25/465/587), so nodemailer + Gmail SMTP can't work there;
// an HTTPS API does.
//   BREVO_API_KEY      - Brevo → SMTP & API → API keys
//   BREVO_SENDER_EMAIL - a sender address verified in Brevo
//   FRONTEND_URL       - where reset-password.html lives (also used by CORS)
const BREVO_API_KEY      = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const APP_URL            = (process.env.FRONTEND_URL || 'http://localhost:5500').replace(/\/+$/, '');
const RESET_LINK_MINUTES = 30;
if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
  console.warn('[auth] BREVO_API_KEY / BREVO_SENDER_EMAIL not set — password reset emails are disabled.');
}

// Only the SHA-256 of a reset token is stored, so a leaked database
// doesn't hand out working reset links.
function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function sendBrevoEmail({ to, subject, text, html }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'BugBeat', email: BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html
    })
  });
  if (!response.ok) {
    throw new Error(`Brevo responded ${response.status}: ${await response.text()}`);
  }
}

async function sendSignupCodeEmail(toEmail, username, code) {
  const name = escapeHtml(username || 'there');
  await sendBrevoEmail({
    to: toEmail,
    subject: `${code} is your BugBeat verification code`,
    text:
      `Hi ${username || 'there'},\n\n` +
      `Your BugBeat verification code is: ${code}\n\n` +
      `Enter it on the sign-up page to finish creating your account. It expires in ${SIGNUP_CODE_MINUTES} minutes.\n\n` +
      `If you didn't try to sign up for BugBeat, you can ignore this email.\n\n— BugBeat`,
    html:
      `<p>Hi ${name},</p>` +
      `<p>Your BugBeat verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p>` +
      `<p>Enter it on the sign-up page to finish creating your account. It expires in ${SIGNUP_CODE_MINUTES} minutes.</p>` +
      `<p style="font-size:13px;color:#666">If you didn't try to sign up for BugBeat, you can ignore this email.</p>`
  });
}

async function sendPasswordResetEmail(toEmail, username, link) {
  const name = escapeHtml(username || 'there');
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'BugBeat', email: BREVO_SENDER_EMAIL },
      to: [{ email: toEmail }],
      subject: 'Reset your BugBeat password',
      textContent:
        `Hi ${username || 'there'},\n\n` +
        `Someone asked to reset the password for your BugBeat account. ` +
        `Open this link to choose a new password (it works once and expires in ${RESET_LINK_MINUTES} minutes):\n\n` +
        `${link}\n\n` +
        `If you didn't ask for this, you can ignore this email. Your password won't change.\n\n— BugBeat`,
      htmlContent:
        `<p>Hi ${name},</p>` +
        `<p>Someone asked to reset the password for your BugBeat account. ` +
        `Click the button below to choose a new password. The link works once and expires in ${RESET_LINK_MINUTES} minutes.</p>` +
        `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1de4a8;color:#0d0d0d;` +
        `text-decoration:none;border-radius:6px;font-weight:600">Reset password</a></p>` +
        `<p style="font-size:13px;color:#666">Or paste this link into your browser:<br>${escapeHtml(link)}</p>` +
        `<p style="font-size:13px;color:#666">If you didn't ask for this, you can ignore this email. Your password won't change.</p>`
    })
  });
  if (!response.ok) {
    throw new Error(`Brevo responded ${response.status}: ${await response.text()}`);
  }
}

// Stricter than authLimiter: every request can send an email.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Please wait a while before trying again.' },
});

// ── POST /auth/forgot-password ─────────────────
// Always answers with the same message, whether or not the email has an
// account, so this can't be used to find out which emails are registered.
// The reply is sent before the lookup/email work so the response time
// doesn't give that away either.
app.post('/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    return res.status(503).json({ error: 'Password reset by email is not set up on this server yet.' });
  }

  const email = String(req.body?.email || '').trim();
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  res.json({
    message: "If an account uses that email, we've sent it a link to reset the password. " +
             'Check your inbox (and spam folder). The link expires in ' + RESET_LINK_MINUTES + ' minutes.'
  });

  try {
    const [users] = await db.query('SELECT id, username, email FROM users WHERE email = ? LIMIT 1', [email]);
    if (users.length === 0) return;
    const user = users[0];

    // One working link at a time: requesting a new one cancels older ones.
    await db.query('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);

    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
      [user.id, hashResetToken(token), RESET_LINK_MINUTES]
    );

    const link = `${APP_URL}/reset-password.html?token=${token}`;
    await sendPasswordResetEmail(user.email, user.username, link);
    console.log(`[auth] password reset email sent for user ${user.id}`);
  } catch (err) {
    console.error('/auth/forgot-password error:', err.message);
  }
});

// ── POST /auth/reset-password ──────────────────
// Sets a new password from a reset link's token. The token works once,
// and every session for the account is logged out afterwards.
app.post('/auth/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  const INVALID_LINK = 'This reset link is invalid or has expired. Please request a new one.';

  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ error: INVALID_LINK });
  }
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return res.status(400).json({ error: strength.error });
  }

  try {
    const [rows] = await db.query(
      `SELECT pr.id, pr.user_id
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW()
        LIMIT 1`,
      [hashResetToken(token)]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: INVALID_LINK });
    }
    const { id: resetId, user_id: userId } = rows[0];

    // Claim the token first, so the same link can't be used twice even if
    // two requests arrive at once.
    const [claim] = await db.query(
      'UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL',
      [resetId]
    );
    if (claim.affectedRows === 0) {
      return res.status(400).json({ error: INVALID_LINK });
    }

    const newHash = await hashPassword(newPassword);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);
    await db.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
    await db.query('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [userId]);

    res.json({ message: 'Your password has been reset. You can now log in with your new password.' });
  } catch (err) {
    console.error('/auth/reset-password error:', err.message);
    res.status(500).json({ error: 'Could not reset your password. Please try again.' });
  }
});

// ══════════════════════════════════════════════
// HISTORY ROUTES
// ══════════════════════════════════════════════

// ── POST /history/save ─────────────────────────
app.post('/history/save', requireAuth, async (req, res) => {
  const {
    code_snippet, language = 'auto', total_lines = 0,
    clean_count = 0, warning_count = 0, error_count = 0,
    critical_count = 0, fusion_score = 0, risk_level = 'low',
    issues = [], beat_grid = []
  } = req.body;

  const issues_found = warning_count + error_count + critical_count;

  // The DB's risk_level column only accepts lowercase values ('low',
  // 'medium', 'high', 'critical') — normalize here so any caller that
  // sends a different case (or something invalid) can't break the INSERT.
  const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
  const normalizedRiskLevel = VALID_RISK_LEVELS.has(String(risk_level).toLowerCase())
    ? String(risk_level).toLowerCase()
    : 'low';

  try {
    // Step 1: Save to ANALYSES
    const [result] = await db.query(
      `INSERT INTO analyses
       (user_id, language, total_lines, issues_found,
        clean_count, warning_count, error_count, critical_count,
        fusion_score, risk_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.userId, language, total_lines, issues_found,
        clean_count, warning_count, error_count, critical_count,
        fusion_score, normalizedRiskLevel
      ]
    );

    const analysisId = result.insertId;

    // Step 2: Save to CODE_SNAPSHOTS
    if (code_snippet) {
      await db.query(
        `INSERT INTO code_snapshots (analysis_id, submitted_code, language, total_lines)
         VALUES (?, ?, ?, ?)`,
        [analysisId, code_snippet, language, total_lines]
      );
    }

    // Step 3: Save to ISSUES
    if (issues.length > 0) {
      const issueValues = issues
        .filter(i => i.severity !== 'clean')
        .map(i => [
          analysisId,
          i.line,
          i.severity,
          i.message || i.description || '',
          i.code_snippet || ''
        ]);

      if (issueValues.length > 0) {
        await db.query(
          `INSERT INTO issues
            (analysis_id, line_number, severity, description, code_snippet)
           VALUES ?`,
          [issueValues]
        );
      }
    }

    // Step 4: Save to BEAT_GRID
    if (beat_grid.length > 0) {
      const beatValues = beat_grid.map((cell, index) => [
        analysisId,
        cell.line_number || cell.line || index + 1,
        cell.severity    || 'clean',
        cell.beat_position !== undefined ? cell.beat_position : index
      ]);

      await db.query(
        `INSERT INTO beat_grid
          (analysis_id, line_number, severity, beat_position)
         VALUES ?`,
        [beatValues]
      );
    }

    // Step 5: Save notification
    await db.query(
      `INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)`,
      [
        req.user.userId,
        `Analysis complete — ${issues_found} issues found. Risk level: ${normalizedRiskLevel}.`,
        'analysis'
      ]
    );

    res.json({
      success     : true,
      analysis_id : analysisId,
      message     : 'Analysis saved to history.'
    });

  } catch (err) {
    console.error('/history/save error:', err.message);
    res.status(500).json({ error: 'Could not save analysis.' });
  }
});

// ── GET /history ───────────────────────────────
app.get('/history', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, language, total_lines, issues_found,
              clean_count, warning_count, error_count, critical_count,
              fusion_score, risk_level, created_at
       FROM analyses
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.userId]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error('/history error:', err.message);
    res.status(500).json({ error: 'Could not fetch history.' });
  }
});

// ── GET /history/:id — recall full session ─────
app.get('/history/:id', requireAuth, async (req, res) => {
  const analysisId = req.params.id;
  const userId     = req.user.userId;

  try {
    // Get analysis summary
    const [analyses] = await db.query(
      'SELECT * FROM analyses WHERE id = ? AND user_id = ?',
      [analysisId, userId]
    );

    if (analyses.length === 0) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }

    // Get code snapshot
    const [snapshots] = await db.query(
      `SELECT submitted_code, language, total_lines
       FROM code_snapshots
       WHERE analysis_id = ?`,
      [analysisId]
    );

    // Get issues
    const [issues] = await db.query(
      `SELECT line_number, severity, description, code_snippet
       FROM issues
       WHERE analysis_id = ?
       ORDER BY line_number ASC`,
      [analysisId]
    );

    // Get beat grid
    const [beatGrid] = await db.query(
      `SELECT line_number, severity, beat_position
       FROM beat_grid
       WHERE analysis_id = ?
       ORDER BY beat_position ASC`,
      [analysisId]
    );

    return res.status(200).json({
      success   : true,
      analysis  : analyses[0],
      code      : snapshots[0]?.submitted_code || '',
      issues    : issues,
      beat_grid : beatGrid
    });

  } catch (err) {
    console.error('/history/:id error:', err.message);
    res.status(500).json({ error: 'Could not recall session.' });
  }
});

// ══════════════════════════════════════════════
// MUSIC PREFERENCES ROUTES
// ══════════════════════════════════════════════

// ── POST /music-preferences/save ──────────────
app.post('/music-preferences/save', requireAuth, async (req, res) => {
  const { search_query, style_name, bpm = 120, scale, oscillator_type, drum_pattern } = req.body;
  if (!search_query || !style_name) {
    return res.status(400).json({ error: 'search_query and style_name are required.' });
  }
  try {
    await db.query(
      `INSERT INTO music_preferences
        (user_id, search_query, style_name, bpm, scale, oscillator_type, drum_pattern)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.userId,
        search_query,
        style_name,
        bpm,
        scale           || null,
        oscillator_type || null,
        drum_pattern    ? JSON.stringify(drum_pattern) : null
      ]
    );
    res.json({ message: 'Music preference saved.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not save music preference.' });
  }
});

// ── GET /music-preferences ─────────────────────
app.get('/music-preferences', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, search_query, style_name, bpm, scale, oscillator_type, drum_pattern, used_at
       FROM music_preferences
       WHERE user_id = ?
       ORDER BY used_at DESC LIMIT 10`,
      [req.user.userId]
    );
    res.json({
      preferences: rows.map(p => ({
        ...p,
        drum_pattern: p.drum_pattern ? JSON.parse(p.drum_pattern) : null
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch music preferences.' });
  }
});

// ══════════════════════════════════════════════
// AUDIO ROUTES
// ══════════════════════════════════════════════

// ── POST /audio/upload ─────────────────────────
app.post('/audio/upload', requireAuth, async (req, res) => {
  const { file_name, file_type, file_size } = req.body;
  if (!file_name || !file_type || !file_size) {
    return res.status(400).json({ error: 'file_name, file_type and file_size are required.' });
  }
  try {
    await db.query(
      `INSERT INTO audio_uploads (user_id, file_name, file_type, file_size)
       VALUES (?, ?, ?, ?)`,
      [req.user.userId, file_name, file_type, file_size]
    );
    return res.status(200).json({ success: true, message: 'Audio upload saved.' });
  } catch (err) {
    console.error('/audio/upload error:', err.message);
    return res.status(500).json({ error: 'Failed to save audio upload.' });
  }
});

// ── GET /audio ─────────────────────────────────
app.get('/audio', requireAuth, async (req, res) => {
  try {
    const [uploads] = await db.query(
      `SELECT id, file_name, file_type, file_size, uploaded_at
       FROM audio_uploads
       WHERE user_id = ?
       ORDER BY uploaded_at DESC`,
      [req.user.userId]
    );
    return res.status(200).json({ success: true, uploads });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch uploads.' });
  }
});

// ══════════════════════════════════════════════
// NOTIFICATION ROUTES
// ══════════════════════════════════════════════

// ── GET /notifications ─────────────────────────
app.get('/notifications', requireAuth, async (req, res) => {
  try {
    const [notifications] = await db.query(
      `SELECT id, message, type, is_read, created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user.userId]
    );
    return res.status(200).json({ success: true, notifications });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
});

// ── PATCH /notifications/read-all ─────────────
// NOTE: this must come BEFORE /notifications/:id/read
app.patch('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ?',
      [req.user.userId]
    );
    return res.status(200).json({ success: true, message: 'All notifications marked as read.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update notifications.' });
  }
});

// ── PATCH /notifications/:id/read ─────────────
app.patch('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.userId]
    );
    return res.status(200).json({ success: true, message: 'Notification marked as read.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update notification.' });
  }
});

// ══════════════════════════════════════════════
// CODE EXECUTION (paiza.io guest runner) — powers the Output/console panel
// ══════════════════════════════════════════════
// Judge0 CE (the original plan) dropped its free daily-quota tier and is
// now pay-per-use-only on RapidAPI, which requires a credit card on file.
// paiza.io's public "guest" API key needs no signup/card and is free —
// tradeoffs: ~2s execution cap, no TypeScript support, and it's a
// best-effort community service with no uptime guarantee.
const PAIZA_API_URL = process.env.PAIZA_API_URL || 'https://api.paiza.io';
const PAIZA_API_KEY = process.env.PAIZA_API_KEY || 'guest';

// Maps the frontend's lang-select values to paiza.io language ids.
// 'auto' has no fixed runtime, and 'typescript' isn't offered by paiza.io's
// guest runner — both are intentionally left out, so the frontend blocks
// Run (with a specific message for each case) before it ever reaches here.
const PAIZA_LANGUAGE_IDS = {
  javascript: 'javascript',
  python:     'python3',
  java:       'java',
  cpp:        'cpp',
  rust:       'rust',
  go:         'go',
};

// paiza.io's guest key has no documented quota, but this still gets its
// own limiter on top of requireAuth to keep our app from hammering a
// shared free community resource.
const executeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many run requests. Please wait a while before trying again.' },
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── POST /execute ───────────────────────────────
app.post('/execute', requireAuth, executeLimiter, async (req, res) => {
  const code  = String(req.body?.code  || '');
  const lang  = String(req.body?.lang  || '');
  const stdin = String(req.body?.stdin || '');
  const paizaLang = PAIZA_LANGUAGE_IDS[lang];

  if (!code.trim()) {
    return res.status(400).json({ error: 'Nothing to run — write some code first.' });
  }
  if (code.length > 20000) {
    return res.status(400).json({ error: 'Code is too long to run (max 20,000 characters).' });
  }
  if (!paizaLang) {
    return res.status(400).json({
      error: lang === 'typescript'
        ? "TypeScript can't be run directly — try JavaScript instead."
        : 'Pick a specific language (not Auto-detect) before running.'
    });
  }

  try {
    const createRes = await fetch(`${PAIZA_API_URL}/runners/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        source_code: code,
        language:    paizaLang,
        input:       stdin,
        api_key:     PAIZA_API_KEY,
      }),
    });

    if (!createRes.ok) {
      console.error('/execute paiza create error:', createRes.status, await createRes.text().catch(() => ''));
      return res.status(502).json({ error: 'Could not reach the code execution service. Please try again.' });
    }

    const created = await createRes.json();
    if (!created?.id) {
      return res.status(502).json({ error: 'Code execution service did not accept the submission. Please try again.' });
    }

    // paiza.io's run is async — poll get_details until status flips to
    // "completed". Its own execution cap is only ~2s, so a handful of
    // short polls is plenty; this just bounds total wait time.
    let result = null;
    for (let i = 0; i < 10; i++) {
      await sleep(700);
      const detailsRes = await fetch(
        `${PAIZA_API_URL}/runners/get_details?id=${encodeURIComponent(created.id)}&api_key=${PAIZA_API_KEY}`
      );
      if (!detailsRes.ok) continue;
      const details = await detailsRes.json();
      if (details?.status === 'completed') { result = details; break; }
    }

    if (!result) {
      return res.status(504).json({ error: 'Code execution timed out. Please try again.' });
    }

    res.json({
      status:        result.result === 'success'  ? 'Accepted'
                    : result.result === 'timeout'  ? 'Time Limit Exceeded'
                    : 'Runtime Error',
      statusId:      result.result === 'success' ? 3 : null,
      stdout:        result.stdout || '',
      stderr:        result.stderr || '',
      compileOutput: result.build_stderr || '',
      time:          result.time,
      memory:        result.memory ? Math.round(Number(result.memory) / 1024) : undefined, // bytes → KB
    });
  } catch (err) {
    console.error('/execute error:', err.message);
    res.status(500).json({ error: 'Could not run the code. Please try again.' });
  }
});

// ══════════════════════════════════════════════
// BUG REPORT ROUTES
// ══════════════════════════════════════════════

// ── POST /bug-reports ──────────────────────────
app.post('/bug-reports', requireAuth, async (req, res) => {
  const description = String(req.body?.description || '').trim();
  const pageContext = String(req.body?.page_context || '').slice(0, 255);

  if (!description) {
    return res.status(400).json({ error: 'Please describe the bug before submitting.' });
  }
  if (description.length > 2000) {
    return res.status(400).json({ error: 'Description is too long (max 2000 characters).' });
  }

  try {
    await db.query(
      `INSERT INTO bug_reports (user_id, description, page_context) VALUES (?, ?, ?)`,
      [req.user.userId, description, pageContext || null]
    );
    res.status(201).json({ message: 'Thanks — your bug report has been submitted.' });
  } catch (err) {
    console.error('/bug-reports error:', err.message);
    res.status(500).json({ error: 'Could not submit bug report. Please try again.' });
  }
});

// ══════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════

// ── GET /admin/stats ───────────────────────────
app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [[userCount]]     = await db.query('SELECT COUNT(*) as count FROM users');
    const [[analysisCount]] = await db.query('SELECT COUNT(*) as count FROM analyses');
    const [[issuesCount]]   = await db.query('SELECT SUM(issues_found) as count FROM analyses');
    const [[avgScore]]      = await db.query('SELECT AVG(fusion_score) as avg FROM analyses');
    const [riskBreakdown]   = await db.query(
      'SELECT risk_level, COUNT(*) as count FROM analyses GROUP BY risk_level'
    );
    const [langBreakdown]   = await db.query(
      'SELECT language, COUNT(*) as count FROM analyses GROUP BY language ORDER BY count DESC LIMIT 5'
    );
    const [recentUsers]     = await db.query(
      'SELECT id, username, email, role, created_at, last_login FROM users ORDER BY created_at DESC LIMIT 5'
    );

    res.json({
      totals: {
        users        : userCount.count,
        analyses     : analysisCount.count,
        issues_found : issuesCount.count || 0,
        avg_score    : round(avgScore.avg || 0, 2)
      },
      risk_breakdown : riskBreakdown,
      lang_breakdown : langBreakdown,
      recent_users   : recentUsers
    });

  } catch (err) {
    console.error('/admin/stats error:', err.message);
    res.status(500).json({ error: 'Could not fetch stats.' });
  }
});

// ── GET /admin/users ───────────────────────────
app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT u.id, u.username, u.email, u.role, u.created_at, u.last_login,
             COUNT(a.id) as total_analyses
      FROM users u
      LEFT JOIN analyses a ON a.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch users.' });
  }
});

// ── GET /admin/users/search ────────────────────
app.get('/admin/users/search', requireAdmin, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Search query required.' });
  try {
    const [users] = await db.query(
      `SELECT id, username, email, role, created_at
       FROM users
       WHERE username LIKE ? OR email LIKE ?
       ORDER BY created_at DESC`,
      [`%${q}%`, `%${q}%`]
    );
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Could not search users.' });
  }
});

// ── PUT /admin/users/:id/role ──────────────────
app.put('/admin/users/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  const { id }   = req.params;
  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be "user" or "admin".' });
  }
  if (parseInt(id) === req.user.userId) {
    return res.status(400).json({ error: 'You cannot change your own role.' });
  }
  try {
    await db.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    // Force any of this user's existing sessions to re-authenticate so the
    // role change (e.g. an admin demotion) takes effect immediately instead
    // of waiting out the old token's remaining lifetime.
    await db.query('DELETE FROM sessions WHERE user_id = ?', [id]);
    res.json({ message: `User role updated to ${role}.` });
  } catch (err) {
    res.status(500).json({ error: 'Could not update role.' });
  }
});

// ── DELETE /admin/users/:id ────────────────────
app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.userId) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  try {
    // Revoke any active sessions first so a deleted account's still-valid
    // JWT can't keep being used against endpoints that don't re-check users.
    await db.query('DELETE FROM sessions WHERE user_id = ?', [id]);
    await db.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ message: 'User deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete user.' });
  }
});

// ── Admin invite links ─────────────────────────
// There's no public way to sign up as an admin. An existing admin creates
// a one-time invite link (optionally locked to one email); the invitee
// opens it while logged in to a normal, verified account and accepts it.
// Links expire after ADMIN_INVITE_HOURS, work once, can be revoked, and
// only a SHA-256 of the token is stored.
const ADMIN_INVITE_HOURS = 48;
const INVALID_INVITE = 'This invite link is invalid, has expired, or has already been used. Ask an admin for a new one.';

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// "roland@gmail.com" -> "r****d@gmail.com", so a leaked link doesn't
// reveal the full address it's locked to.
function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '';
  const hidden = name.length <= 2 ? name[0] + '*' : name[0] + '*'.repeat(Math.min(name.length - 2, 6)) + name[name.length - 1];
  return `${hidden}@${domain}`;
}

async function findUsableInvite(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [rows] = await db.query(
    `SELECT id, email FROM admin_invites
      WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
      LIMIT 1`,
    [hashInviteToken(token)]
  );
  return rows[0] || null;
}

// ── POST /admin/invites ────────────────────────
app.post('/admin/invites', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (email && (!EMAIL_PATTERN.test(email) || email.length > 254)) {
    return res.status(400).json({ error: 'Please enter a valid email address, or leave it empty.' });
  }
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const [result] = await db.query(
      `INSERT INTO admin_invites (token_hash, email, created_by, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      [hashInviteToken(token), email || null, req.user.userId, ADMIN_INVITE_HOURS]
    );
    res.status(201).json({
      id: result.insertId,
      link: `${APP_URL}/admin-invite.html?token=${token}`,
      email: email || null,
      expiresInHours: ADMIN_INVITE_HOURS
    });
  } catch (err) {
    console.error('POST /admin/invites error:', err.message);
    res.status(500).json({ error: 'Could not create the invite.' });
  }
});

// ── GET /admin/invites ─────────────────────────
app.get('/admin/invites', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT i.id, i.email, i.created_at, i.expires_at, i.used_at, i.revoked_at,
              c.username AS created_by, u.username AS used_by,
              CASE
                WHEN i.used_at    IS NOT NULL THEN 'used'
                WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                WHEN i.expires_at <= NOW()    THEN 'expired'
                ELSE 'active'
              END AS status
         FROM admin_invites i
         LEFT JOIN users c ON c.id = i.created_by
         LEFT JOIN users u ON u.id = i.used_by
        ORDER BY i.created_at DESC
        LIMIT 50`
    );
    res.json({ invites: rows });
  } catch (err) {
    console.error('GET /admin/invites error:', err.message);
    res.status(500).json({ error: 'Could not load invites.' });
  }
});

// ── DELETE /admin/invites/:id ──────────────────
// Revokes an invite that hasn't been used yet.
app.delete('/admin/invites/:id', requireAdmin, async (req, res) => {
  try {
    const [result] = await db.query(
      'UPDATE admin_invites SET revoked_at = NOW() WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
      [req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'That invite was already used or revoked.' });
    }
    res.json({ message: 'Invite revoked.' });
  } catch (err) {
    console.error('DELETE /admin/invites error:', err.message);
    res.status(500).json({ error: 'Could not revoke the invite.' });
  }
});

// ── POST /auth/admin-invite/check ──────────────
// Lets admin-invite.html tell the visitor up front whether the link still
// works (and which email it's for) before they log in. Not on authLimiter:
// the page calls it on every visit (before and after logging in), and a
// 256-bit token can't be guessed anyway; the general limiter still applies.
app.post('/auth/admin-invite/check', async (req, res) => {
  try {
    const invite = await findUsableInvite(req.body?.token);
    if (!invite) return res.json({ valid: false, error: INVALID_INVITE });
    res.json({ valid: true, emailHint: invite.email ? maskEmail(invite.email) : null, expiresInHours: ADMIN_INVITE_HOURS });
  } catch (err) {
    console.error('/auth/admin-invite/check error:', err.message);
    res.status(500).json({ error: 'Could not check the invite. Please try again.' });
  }
});

// ── POST /auth/admin-invite/accept ─────────────
app.post('/auth/admin-invite/accept', requireAuth, authLimiter, async (req, res) => {
  try {
    const invite = await findUsableInvite(req.body?.token);
    if (!invite) return res.status(400).json({ error: INVALID_INVITE });

    const [users] = await db.query('SELECT id, email, role FROM users WHERE id = ? LIMIT 1', [req.user.userId]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found.' });
    const me = users[0];

    if (me.role === 'admin') {
      return res.status(400).json({ error: "Your account is already an admin, so this invite wasn't used. You can pass it on to the person it was meant for." });
    }
    if (invite.email && invite.email.toLowerCase() !== String(me.email).toLowerCase()) {
      return res.status(403).json({
        error: `This invite is for ${maskEmail(invite.email)}. Log in with that account to accept it.`
      });
    }

    // Claim the invite first so it can't be used twice, even by two
    // requests at the same moment.
    const [claim] = await db.query(
      `UPDATE admin_invites SET used_at = NOW(), used_by = ?
        WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
      [me.id, invite.id]
    );
    if (claim.affectedRows === 0) return res.status(400).json({ error: INVALID_INVITE });

    await db.query("UPDATE users SET role = 'admin' WHERE id = ?", [me.id]);
    // Same as Promote: end existing sessions so the new role takes effect
    // on the next login.
    await db.query('DELETE FROM sessions WHERE user_id = ?', [me.id]);
    await db.query(
      'INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)',
      [me.id, 'You are now a BugBeat admin. Open the Admin page from the ☰ menu.', 'system']
    );

    res.json({ message: 'You are now an admin. Please log in again to open the Admin page.' });
  } catch (err) {
    console.error('/auth/admin-invite/accept error:', err.message);
    res.status(500).json({ error: 'Could not accept the invite. Please try again.' });
  }
});

// ── GET /admin/analyses ────────────────────────
app.get('/admin/analyses', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT a.id, u.username, a.language, a.total_lines,
             a.issues_found, a.risk_level, a.fusion_score, a.created_at
      FROM analyses a
      JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT 100
    `);
    res.json({ analyses: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch analyses.' });
  }
});

// ── GET /admin/bug-reports ─────────────────────
app.get('/admin/bug-reports', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT b.id, u.username, b.description, b.page_context, b.status, b.created_at
      FROM bug_reports b
      JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC
      LIMIT 200
    `);
    res.json({ bug_reports: rows });
  } catch (err) {
    console.error('/admin/bug-reports error:', err.message);
    res.status(500).json({ error: 'Could not fetch bug reports.' });
  }
});

// ── PATCH /admin/bug-reports/:id/status ────────
const VALID_BUG_STATUSES = new Set(['open', 'in_progress', 'resolved']);
app.patch('/admin/bug-reports/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const { id }      = req.params;
  if (!VALID_BUG_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    await db.query('UPDATE bug_reports SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: 'Status updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not update status.' });
  }
});

// ── Helper ─────────────────────────────────────
function round(val, decimals) {
  return Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// ── Start ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BugBeat server running on port ${PORT}`);
});