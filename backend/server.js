// ═══════════════════════════════════════════════
//  BUGBEAT — server.js
//  Endpoints:
//  POST /analyze      → Gemini code analysis
//  POST /music-search → Gemini music parameters
//  POST /complexity   → ML complexity analysis
//  POST /auth/signup  → Register new user
//  POST /auth/login   → Login + get JWT token
//  GET  /auth/me      → Get current user info
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
import db       from './db.js';
import { hashPassword, verifyPassword, generateToken, requireAuth, requireAdmin, validatePasswordStrength } from './auth.js';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;
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

// ── POST /auth/signup ──────────────────────────
app.post('/auth/signup', authLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Restrict usernames to a safe character set so stored values can never
  // break out of HTML/JS when rendered elsewhere (e.g. the admin panel).
  // Letters, numbers, underscore, hyphen, period — 3 to 20 characters.
  const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,20}$/;
  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3-20 characters and can only contain letters, numbers, underscores, hyphens, and periods.'
    });
  }

  // Basic email format check + length cap (defense in depth, not a full RFC validator)
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.valid) {
    return res.status(400).json({ error: passwordCheck.error });
  }

  try {
    // Check existing
    const [existing] = await db.query(
      'SELECT id FROM users WHERE email = ? OR username = ?',
      [email, username]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email or username already in use.' });
    }

    // Hash and insert
    const hash     = await hashPassword(password);
    const [newUser] = await db.query(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [username, email, hash, 'user']
    );

    // Generate token
    const token = generateToken({
      userId   : newUser.insertId,
      email,
      username,
      role     : 'user'
    });

    // Save session
    const signupExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO sessions (user_id, token, ip_address, device_info, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        newUser.insertId,
        token,
        req.ip || '',
        req.headers['user-agent'] || '',
        signupExpiry
      ]
    );

    // Welcome notification
    await db.query(
      `INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)`,
      [
        newUser.insertId,
        'Welcome to BugBeat! Submit your first code analysis to get started.',
        'system'
      ]
    );

    res.status(201).json({
      message : 'Account created successfully!',
      token,
      user    : { id: newUser.insertId, username, email, role: 'user' }
    });

  } catch (err) {
    console.error('/auth/signup error:', err.message);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
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

    const user  = rows[0];
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

// ── GET /auth/me ───────────────────────────────
app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, email, role, created_at, last_login FROM users WHERE id = ?',
      [req.user.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ user: rows[0] });
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