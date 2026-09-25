/* ═══════════════════════════════════════════════
   CODEBEAT — app.js
   Monaco Editor + Tone.js multi-layer music +
   Web Audio API file upload + Gemini analysis
═══════════════════════════════════════════════ */

// Auto-detects environment: Live Server / localhost keeps hitting your local
// backend for development, while the deployed Vercel site talks to Render —
// so you don't have to hand-edit this every time you switch between the two.
const BACKEND_URL =
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://bugbeat.onrender.com';

// ── Auth guard ─────────────────────────────────
// Redirect to login if not logged in
const cbToken = localStorage.getItem('cb_token');
const cbUser  = JSON.parse(localStorage.getItem('cb_user') || 'null');

if (!cbToken || !cbUser) {
  window.location.href = 'login.html';
}

// Show user greeting + logout
const userGreeting = document.getElementById('user-greeting');
const logoutBtn    = document.getElementById('logout-btn');

if (userGreeting) userGreeting.textContent = `👤 ${cbUser?.username || ''}`;

// Show admin link only for admins
const adminLink = document.getElementById('admin-link');
if (adminLink && cbUser?.role === 'admin') adminLink.hidden = false;
// #admin-link used to be an <a href="admin.html">, styled to look like a
// button via the same .cb-btn classes every other header control uses —
// it's a real <button> now for consistency, so it navigates via JS
// instead of a native href.
if (adminLink) {
  adminLink.addEventListener('click', () => {
    window.location.href = 'admin.html';
  });
}

// Logout (with its "Log out?" confirmation) is handled in logout.js.

// Helper: auth headers for protected routes
function authHeaders() {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${cbToken}`
  };
}

// ── Bug report ───────────────────────────────────
const bugreportFab      = document.getElementById('bugreport-fab');
const bugreportModal    = document.getElementById('bugreport-modal');
const bugreportClose    = document.getElementById('bugreport-close-btn');
const bugreportCancel   = document.getElementById('bugreport-cancel-btn');
const bugreportSubmit   = document.getElementById('bugreport-submit-btn');
const bugreportTextarea = document.getElementById('bugreport-description');
const bugreportMsg      = document.getElementById('bugreport-msg');

function openBugReportModal() {
  if (!bugreportModal) return;
  bugreportTextarea.value = '';
  bugreportMsg.hidden = true;
  bugreportMsg.className = 'cb-bugreport-modal__msg';
  bugreportModal.hidden = false;
  bugreportTextarea.focus();
}

function closeBugReportModal() {
  if (bugreportModal) bugreportModal.hidden = true;
}

if (bugreportFab)    bugreportFab.addEventListener('click', openBugReportModal);
if (bugreportClose)  bugreportClose.addEventListener('click', closeBugReportModal);
if (bugreportCancel) bugreportCancel.addEventListener('click', closeBugReportModal);
if (bugreportModal) {
  // Click on the dark overlay (outside the box) also closes it
  bugreportModal.addEventListener('click', e => {
    if (e.target === bugreportModal) closeBugReportModal();
  });
}

if (bugreportSubmit) {
  bugreportSubmit.addEventListener('click', async () => {
    const description = bugreportTextarea.value.trim();
    if (!description) {
      bugreportMsg.textContent = 'Please describe the bug before submitting.';
      bugreportMsg.className = 'cb-bugreport-modal__msg cb-bugreport-modal__msg--error';
      bugreportMsg.hidden = false;
      return;
    }

    bugreportSubmit.disabled    = true;
    bugreportSubmit.textContent = 'Submitting…';

    try {
      const res  = await fetch(`${BACKEND_URL}/bug-reports`, {
        method  : 'POST',
        headers : authHeaders(),
        body    : JSON.stringify({ description, page_context: window.location.pathname })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit bug report.');

      bugreportMsg.textContent = data.message || 'Thanks — your bug report has been submitted.';
      bugreportMsg.className = 'cb-bugreport-modal__msg cb-bugreport-modal__msg--success';
      bugreportMsg.hidden = false;
      setTimeout(closeBugReportModal, 1500);
    } catch (err) {
      bugreportMsg.textContent = err.message;
      bugreportMsg.className = 'cb-bugreport-modal__msg cb-bugreport-modal__msg--error';
      bugreportMsg.hidden = false;
    } finally {
      bugreportSubmit.disabled    = false;
      bugreportSubmit.textContent = 'Submit Report';
    }
  });
}

// ── Notifications ───────────────────────────────
// GET /notifications, PATCH /notifications/:id/read and PATCH
// /notifications/read-all already existed on the backend (a signup and
// every completed analysis both insert a row) with nothing in the UI
// ever calling them — this bell + dropdown is that missing frontend.
const notifBtn      = document.getElementById('notif-btn');
const notifBadge    = document.getElementById('notif-badge');
const notifDropdown = document.getElementById('notif-dropdown');
const notifWrap     = document.getElementById('notif-wrap');
const notifList     = document.getElementById('notif-list');
const notifMarkAll  = document.getElementById('notif-mark-all');

let notifications = [];

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)  return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function renderNotifications() {
  if (!notifList) return;
  if (!notifications.length) {
    notifList.innerHTML = '<div class="cb-notif__empty">No notifications yet.</div>';
  } else {
    notifList.innerHTML = '';
    notifications.forEach(n => {
      const item = document.createElement('div');
      item.className = 'cb-notif__item' + (n.is_read ? '' : ' cb-notif__item--unread');
      item.setAttribute('role', 'menuitem');
      item.tabIndex = 0;

      const msg = document.createElement('span');
      msg.className = 'cb-notif__item-msg';
      msg.textContent = n.message;

      const time = document.createElement('span');
      time.className = 'cb-notif__item-time';
      time.textContent = timeAgo(n.created_at);

      item.append(msg, time);
      item.addEventListener('click', () => markNotificationRead(n.id));
      notifList.appendChild(item);
    });
  }

  const unreadCount = notifications.filter(n => !n.is_read).length;
  if (notifBadge) {
    if (unreadCount > 0) {
      notifBadge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      notifBadge.hidden = false;
    } else {
      notifBadge.hidden = true;
    }
  }
  if (notifMarkAll) notifMarkAll.disabled = unreadCount === 0;
}

async function fetchNotifications() {
  // Always re-render, on success, a server error, or the backend being
  // unreachable — otherwise a failed fetch (e.g. backend not running)
  // leaves the badge/button/list stuck in whatever the HTML happened
  // to start in, rather than the empty-and-disabled state they should
  // show for zero known notifications.
  try {
    const res  = await fetch(`${BACKEND_URL}/notifications`, { headers: authHeaders() });
    const data = await res.json();
    notifications = (res.ok && Array.isArray(data.notifications)) ? data.notifications : [];
  } catch (err) {
    console.warn('Could not load notifications:', err.message);
    notifications = [];
  }
  renderNotifications();
}

async function markNotificationRead(id) {
  const target = notifications.find(n => n.id === id);
  if (!target || target.is_read) return;
  target.is_read = 1;
  renderNotifications(); // optimistic — don't make the click wait on a round trip
  try {
    const res = await fetch(`${BACKEND_URL}/notifications/${id}/read`, {
      method:  'PATCH',
      headers: authHeaders()
    });
    if (!res.ok) throw new Error('Failed to mark as read');
  } catch (err) {
    console.warn('Could not mark notification as read:', err.message);
  }
}

if (notifMarkAll) {
  notifMarkAll.addEventListener('click', async () => {
    if (!notifications.some(n => !n.is_read)) return;
    notifications.forEach(n => { n.is_read = 1; });
    renderNotifications();
    try {
      const res = await fetch(`${BACKEND_URL}/notifications/read-all`, {
        method:  'PATCH',
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('Failed to mark all as read');
    } catch (err) {
      console.warn('Could not mark all notifications as read:', err.message);
    }
  });
}

if (notifBtn && notifDropdown && notifWrap) {
  notifBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !notifDropdown.hidden;
    notifDropdown.hidden = isOpen;
    notifBtn.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen) {
      if (window.keepInView) keepInView(notifDropdown); // don't let it hang off the screen edge
      fetchNotifications(); // refresh right as it opens
    }
  });
  document.addEventListener('click', (e) => {
    if (!notifDropdown.hidden && !notifWrap.contains(e.target)) {
      notifDropdown.hidden = true;
      notifBtn.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !notifDropdown.hidden) {
      notifDropdown.hidden = true;
      notifBtn.setAttribute('aria-expanded', 'false');
    }
  });
}

// Populate the unread badge as soon as the page loads, without waiting
// for the dropdown to be opened.
fetchNotifications();

// ── DOM refs ───────────────────────────────────
const langSelect     = document.getElementById('lang-select');
const analyzeBtn     = document.getElementById('analyze-btn');
const runBtn         = document.getElementById('run-btn');
const outputPanel    = document.getElementById('output-panel');
const outputBody     = document.getElementById('output-body');
const outputStatus   = document.getElementById('output-status');
const outputMeta     = document.getElementById('output-meta');
const outputCloseBtn = document.getElementById('output-close-btn');
const clearBtn       = document.getElementById('clear-btn');
const demoSelect     = document.getElementById('demo-select');
const lineCount      = document.getElementById('line-count');
const errorBanner    = document.getElementById('error-banner');
const errorBannerMsg = document.getElementById('error-banner-msg');
const sequencer      = document.getElementById('sequencer');
const playBtn        = document.getElementById('play-btn');
const stopBtn        = document.getElementById('stop-btn');
const bpmRange       = document.getElementById('bpm-range');
const bpmVal         = document.getElementById('bpm-val');

// The BPM slider is fully custom-styled (see style.css), so the
// "filled" green portion up to the thumb isn't drawn by the browser
// automatically anymore — recompute it as a gradient on every change.
function updateBpmFill() {
  const min = parseFloat(bpmRange.min) || 0;
  const max = parseFloat(bpmRange.max) || 100;
  const val = parseFloat(bpmRange.value) || min;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  bpmRange.style.setProperty('--bpm-fill', `${pct}%`);
}
updateBpmFill();
const progressFill   = document.getElementById('progress-fill');
const currentLine    = document.getElementById('current-line');
const issueList      = document.getElementById('issue-list');
const issueCount     = document.getElementById('issue-count');
const mlComplexityEl = document.getElementById('ml-complexity');
const mlUnavailableEl= document.getElementById('ml-complexity-unavailable');
const mlRiskBadge    = document.getElementById('ml-risk-badge');
const mlScore        = document.getElementById('ml-score');
const mlLang         = document.getElementById('ml-lang');
const mlSummary      = document.getElementById('ml-summary');
const musicSearch    = document.getElementById('music-search');
const musicSearchBtn = document.getElementById('music-search-btn');
const musicStatus    = document.getElementById('music-status');
const audioUpload    = document.getElementById('audio-upload');
const audioLabel     = document.getElementById('audio-label');
const audioRemoveBtn = document.getElementById('audio-remove-btn');

// ── Monaco instance ────────────────────────────
let monacoEditor = null;

function getCode() {
  return monacoEditor ? monacoEditor.getValue() : '';
}

function setCode(code, lang = 'javascript') {
  if (!monacoEditor) return;
  const langId = lang === 'auto' ? 'javascript' : lang === 'cpp' ? 'cpp' : lang;
  monaco.editor.setModelLanguage(monacoEditor.getModel(), langId);
  monacoEditor.setValue(code);
  monacoEditor.setScrollPosition({ scrollTop: 0 });
}

function getMonacoLang(lang) {
  const map = { javascript: 'javascript', python: 'python', typescript: 'typescript',
                java: 'java', cpp: 'cpp', rust: 'rust', go: 'go', auto: 'javascript' };
  return map[lang] || 'javascript';
}

// ── Monaco decorations (highlight error lines) ─
let decorations = [];
function highlightEditorLines(lines) {
  if (!monacoEditor) return;
  const severityColors = {
    warning:  '#281a06',
    error:    '#26110a',
    critical: '#240909'
  };
  const newDecorations = lines
    .filter(l => l.severity !== 'clean')
    .map(l => ({
      range: new monaco.Range(l.line, 1, l.line, 1),
      options: {
        isWholeLine: true,
        className: `monaco-line-${l.severity}`,
        glyphMarginClassName: `monaco-glyph-${l.severity}`,
        overviewRuler: {
          color: l.severity === 'critical' ? '#d43c3c'
               : l.severity === 'error'    ? '#d45a30'
               : '#d9921e',
          position: monaco.editor.OverviewRulerLane.Right
        },
        minimap: {
          color: l.severity === 'critical' ? '#d43c3c'
               : l.severity === 'error'    ? '#d45a30'
               : '#d9921e',
          position: monaco.editor.MinimapPosition.Inline
        }
      }
    }));
  decorations = monacoEditor.deltaDecorations(decorations, newDecorations);
}

function highlightActiveLine(lineNum) {
  if (!monacoEditor) return;
  monacoEditor.revealLineInCenterIfOutsideViewport(lineNum);
}

function clearDecorations() {
  if (!monacoEditor) return;
  decorations = monacoEditor.deltaDecorations(decorations, []);
}

// ── State ──────────────────────────────────────
let beatData     = [];
let isPlaying    = false;
let playIndex    = 0;
let playTimer    = null;
let currentStyle = null;
let toneLoop     = null;
let chordIndex   = 0;
let synthsReady  = false;

// ── Audio file state ───────────────────────────
let audioContext   = null;
let audioBuffer    = null;
let audioSource    = null;
let audioGain      = null;
let audioDistNode  = null;
let uploadedFile   = null;

// ── Tone.js nodes ──────────────────────────────
let bassSynth, padSynth, melodySynth, leadSynth;
let kickSynth, snareSynth, hihatSynth, openHihatSynth;
let reverb, chorus, distortion, pitchShift, limiter;

// ── Default style ──────────────────────────────
const DEFAULT_STYLE = {
  name: 'Default Chill',
  description: 'A warm lo-fi vibe to get you started',
  bpm: 85,
  oscillatorType: 'triangle',
  scale: ['C3','Eb3','F3','G3','Bb3','C4','Eb4','F4','G4','Bb4'],
  chordProgression: [
    ['C3','Eb3','G3','Bb3'],
    ['Bb2','D3','F3','Ab3'],
    ['Ab2','C3','Eb3','G3'],
    ['G2','Bb2','D3','F3']
  ],
  bassLine:  ['C2','C2','Bb1','Bb1','Ab1','Ab1','G1','G1'],
  padChords: [['C4','Eb4','G4'],['Bb3','D4','F4'],['Ab3','C4','Eb4'],['G3','Bb3','D4']],
  leadNotes: ['G4','Bb4','C5','Eb5','F5','G5','Bb5','C6'],
  chordMap: {
    clean:    ['C4','G4'],
    warning:  ['Bb3','F4'],
    error:    ['Eb3','Bb3'],
    critical: ['C3','Gb3']
  },
  envelope:   { attack: 0.05, decay: 0.3, sustain: 0.4, release: 0.8 },
  reverbWet:  0.45,
  chorusWet:  0.25,
  volume:     -14,
  loopPattern: {
    kick:    [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],
    snare:   [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
    hihat:   [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    openHat: [0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1]
  },
  drumKit: {
    kickPitchDecay: 0.06,
    kickOctaves: 8,
    snareNoiseType: 'white',
    hihatFrequency: 400,
    hihatDecay: 0.04
  }
};

// ── Severity FX ────────────────────────────────
const SEVERITY_FX = {
  clean:    { distortion: 0,    pitchShift: 0,  rateMult: 1.0,  distWet: 0,    stayMs: 300  },
  warning:  { distortion: 0.2,  pitchShift: -2, rateMult: 0.97, distWet: 0.25, stayMs: 700  },
  error:    { distortion: 0.55, pitchShift: -5, rateMult: 0.92, distWet: 0.55, stayMs: 1000 },
  critical: { distortion: 0.9,  pitchShift: -9, rateMult: 0.8,  distWet: 0.9,  stayMs: 1500 }
};

// ═══════════════════════════════════════════════
// AUDIO FILE UPLOAD
// ═══════════════════════════════════════════════
if (audioUpload) {
  audioUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    uploadedFile = file;
    audioLabel.textContent = `🎵 ${file.name}`;
    audioRemoveBtn.hidden  = false;
    try {
      audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await file.arrayBuffer();
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      setMusicStatus(`✅ "${file.name}" loaded — replaces the synthesized music, with error effects applied directly to it`, 'ok');
    } catch(err) {
      setMusicStatus('⚠ Could not decode audio file. Try an MP3 or WAV.', 'error');
      audioBuffer = null;
    }
  });
}

if (audioRemoveBtn) {
  audioRemoveBtn.addEventListener('click', () => {
    uploadedFile = null; audioBuffer = null;
    audioUpload.value = '';
    audioLabel.textContent = 'Upload audio';
    audioRemoveBtn.hidden  = true;
    setMusicStatus('Audio removed — using synthesized music', '');
    stopAudioFile();
  });
}

function playAudioFile() {
  if (!audioBuffer || !audioContext) return;
  stopAudioFile();
  audioContext.resume();
  audioGain     = audioContext.createGain();
  audioGain.gain.value = 0.75;
  audioDistNode = audioContext.createWaveShaper();
  audioDistNode.curve      = makeDistortionCurve(0);
  audioDistNode.oversample = '4x';
  audioSource              = audioContext.createBufferSource();
  audioSource.buffer       = audioBuffer;
  audioSource.loop         = true;
  audioSource.playbackRate.value = 1.0;
  audioSource.connect(audioDistNode);
  audioDistNode.connect(audioGain);
  audioGain.connect(audioContext.destination);
  audioSource.start(0);
}

function stopAudioFile() {
  try { audioSource?.stop(); audioSource?.disconnect(); } catch(e) {}
  audioSource = null;
}

function applyAudioFx(severity) {
  if (!audioSource || !audioDistNode) return;
  const fx = SEVERITY_FX[severity];
  audioDistNode.curve = makeDistortionCurve(fx.distortion * 400);
  audioSource.playbackRate.value = fx.rateMult;
}

function resetAudioFx() {
  if (!audioSource || !audioDistNode) return;
  audioDistNode.curve = makeDistortionCurve(0);
  audioSource.playbackRate.value = 1.0;
}

function makeDistortionCurve(amount) {
  const n = 256, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = amount === 0 ? x : ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// ═══════════════════════════════════════════════
// MUSIC SEARCH
// ═══════════════════════════════════════════════
if (musicSearchBtn) musicSearchBtn.addEventListener('click', doMusicSearch);
if (musicSearch)    musicSearch.addEventListener('keydown', e => { if (e.key === 'Enter') doMusicSearch(); });

async function doMusicSearch() {
  const query = musicSearch.value.trim();
  if (!query) return;
  musicSearchBtn.disabled = true;
  musicSearchBtn.textContent = '⏳';
  setMusicStatus('Searching…', 'loading');
  try {
    const res  = await fetch(`${BACKEND_URL}/music-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    currentStyle = { ...DEFAULT_STYLE, ...data.style,
      loopPattern: data.style.loopPattern || DEFAULT_STYLE.loopPattern,
      padChords:   data.style.padChords || DEFAULT_STYLE.padChords,
      bassLine:    data.style.bassLine  || DEFAULT_STYLE.bassLine,
      leadNotes:   data.style.leadNotes || DEFAULT_STYLE.leadNotes
    };
    bpmRange.value = currentStyle.bpm;
    bpmVal.textContent = currentStyle.bpm;
    updateBpmFill();
    // teardownSynths() disposes the active instruments and stops the
    // background loop, but it doesn't touch isPlaying, the Play button,
    // or the line-by-line beat timer — so searching mid-playback used to
    // leave the button stuck on "⏸" with the full arrangement silently
    // gone, while the timer kept firing sparse accent notes on the
    // freshly-rebuilt (but never restarted) synths. Stopping and
    // restarting playback around the rebuild keeps that in sync, so a
    // search always resumes with the *complete* matched arrangement
    // instead of a half-torn-down one.
    const wasPlaying = isPlaying;
    if (wasPlaying) stopPlayback();
    if (synthsReady) teardownSynths();
    initSynths();
    if (wasPlaying) startPlayback();
    setMusicStatus(`🎵 ${currentStyle.name} — ${currentStyle.description}`, 'ok');
    // Mirrors how analysis results auto-save to history after every
    // Analyze — no separate "save" step there either. The backend route
    // for this already existed and worked fine; it just had nothing
    // calling it, which is why music_preferences was empty.
    saveMusicPreference(query, currentStyle);
  } catch (err) {
    setMusicStatus(`⚠ ${err.message}`, 'error');
  } finally {
    musicSearchBtn.disabled = false;
    musicSearchBtn.textContent = '🔍';
  }
}

function setMusicStatus(msg, state) {
  if (!musicStatus) return;
  musicStatus.textContent = msg;
  musicStatus.className   = 'cb-music-status' + (state ? ' cb-music-status--' + state : '');
}

async function saveMusicPreference(query, style) {
  try {
    const res = await fetch(`${BACKEND_URL}/music-preferences/save`, {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({
        search_query:    query,
        style_name:      style.name,
        bpm:             style.bpm,
        scale:           Array.isArray(style.scale) ? style.scale.join(',') : (style.scale || null),
        oscillator_type: style.oscillatorType || null,
        drum_pattern:    style.loopPattern || null
      })
    });
    if (!res.ok) {
      const data = await res.json();
      console.warn('Music preference save failed:', data?.error || res.status);
    }
  } catch (err) {
    // Silent fail — never interrupt the user experience
    console.warn('Could not save music preference:', err.message);
  }
}

// ═══════════════════════════════════════════════
// TONE.JS — FULL MULTI-LAYER ENGINE
// ═══════════════════════════════════════════════
function getStyle() { return currentStyle || DEFAULT_STYLE; }

function initSynths() {
  if (synthsReady) return;
  const style = getStyle();
  const oscType = style.oscillatorType || 'triangle';
  const drum = style.drumKit || {};

  limiter    = new Tone.Limiter(-2).toDestination();
  reverb     = new Tone.Reverb({ decay: 2.0, wet: style.reverbWet }).connect(limiter);
  chorus     = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: style.chorusWet }).connect(reverb);
  distortion = new Tone.Distortion({ distortion: 0, wet: 0 }).connect(chorus);
  pitchShift = new Tone.PitchShift({ pitch: 0, windowSize: 0.1 }).connect(distortion);

  bassSynth = new Tone.Synth({
    oscillator: { type: oscType },
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.5 },
    volume: -10
  }).connect(pitchShift);

  padSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: oscType },
    envelope: { attack: 0.3, decay: 0.5, sustain: 0.7, release: 1.5 },
    volume: -22
  }).connect(reverb);

  melodySynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: oscType },
    envelope: style.envelope,
    volume: style.volume ?? -14
  }).connect(pitchShift);

  leadSynth = new Tone.Synth({
    oscillator: { type: oscType },
    envelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.4 },
    volume: -11
  }).connect(pitchShift);

  const hihatFreq = drum.hihatFrequency ?? 400;

  kickSynth = new Tone.MembraneSynth({
    pitchDecay: drum.kickPitchDecay ?? 0.06, octaves: drum.kickOctaves ?? 8,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 },
    volume: -12
  }).connect(limiter);

  snareSynth = new Tone.NoiseSynth({
    noise: { type: drum.snareNoiseType ?? 'white' },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0.02, release: 0.05 },
    volume: -17
  }).connect(reverb);

  hihatSynth = new Tone.MetalSynth({
    frequency: hihatFreq, envelope: { attack: 0.001, decay: drum.hihatDecay ?? 0.04, release: 0.01 },
    harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5,
    volume: -22
  }).connect(limiter);

  openHihatSynth = new Tone.MetalSynth({
    frequency: hihatFreq * 1.5, envelope: { attack: 0.001, decay: 0.3, release: 0.1 },
    harmonicity: 5.1, modulationIndex: 16, resonance: 3000, octaves: 1.5,
    volume: -23
  }).connect(reverb);

  synthsReady = true;
}

function teardownSynths() {
  stopLoop();
  [bassSynth, padSynth, melodySynth, leadSynth,
   kickSynth, snareSynth, hihatSynth, openHihatSynth,
   reverb, chorus, distortion, pitchShift, limiter
  ].forEach(n => { try { n?.dispose(); } catch(e) {} });
  synthsReady = false;
}

function startLoop() {
  stopLoop();
  const style   = getStyle();
  const pattern = style.loopPattern;
  const prog    = style.chordProgression;
  const pads    = style.padChords  || [['C4','E4','G4']];
  const bass    = style.bassLine   || ['C2'];
  const lead    = style.leadNotes  || ['C5'];

  Tone.Transport.bpm.value = parseInt(bpmRange.value);

  const bassSeq = new Tone.Sequence((time, i) => {
    try { bassSynth.triggerAttackRelease(bass[i % bass.length], '8n', time); } catch(e) {}
  }, [...Array(8).keys()], '8n');

  const padSeq = new Tone.Sequence((time, i) => {
    try { padSynth.triggerAttackRelease(pads[i % pads.length], '2n', time); } catch(e) {}
  }, [...Array(4).keys()], '2n');

  const melodySeq = new Tone.Sequence((time, i) => {
    try { melodySynth.triggerAttackRelease(prog[i % prog.length], '4n', time); } catch(e) {}
    chordIndex++;
  }, [...Array(4).keys()], '1n');

  const leadSeq = new Tone.Sequence((time, i) => {
    try { leadSynth.triggerAttackRelease(lead[i % lead.length], '8n', time); } catch(e) {}
  }, [...Array(8).keys()], '4n');

  const drumSeq = new Tone.Sequence((time, i) => {
    const s = i % 16;
    if (pattern.kick?.[s])    { try { kickSynth.triggerAttackRelease('C1','8n',time); } catch(e) {} }
    if (pattern.snare?.[s])   { try { snareSynth.triggerAttackRelease('16n',time); } catch(e) {} }
    if (pattern.hihat?.[s])   { try { hihatSynth.triggerAttackRelease('32n',time); } catch(e) {} }
    if (pattern.openHat?.[s]) { try { openHihatSynth.triggerAttackRelease('8n',time); } catch(e) {} }
  }, [...Array(16).keys()], '16n');

  bassSeq.start(0); padSeq.start(0); melodySeq.start(0);
  leadSeq.start('2m'); drumSeq.start(0);
  Tone.Transport.start();
  toneLoop = { bassSeq, padSeq, melodySeq, leadSeq, drumSeq };
}

function stopLoop() {
  if (toneLoop) {
    Object.values(toneLoop).forEach(seq => { try { seq?.stop(); seq?.dispose(); } catch(e) {} });
  }
  try { Tone.Transport.stop(); Tone.Transport.cancel(); } catch(e) {}
  toneLoop = null; chordIndex = 0;
}

function applyFx(severity) {
  const fx = SEVERITY_FX[severity] || SEVERITY_FX.clean;
  try {
    distortion.distortion = fx.distortion;
    distortion.wet.value  = fx.distWet;
    pitchShift.pitch      = fx.pitchShift;
  } catch(e) {}
  applyAudioFx(severity);
}

function resetFx() {
  try {
    distortion.distortion = 0;
    distortion.wet.value  = 0;
    pitchShift.pitch      = 0;
  } catch(e) {}
  resetAudioFx();
}

function accentBeat(severity) {
  if (!synthsReady || severity === 'clean') return;
  const style = getStyle();
  const notes = style.chordMap?.[severity] || ['C4'];
  const now   = Tone.now() + 0.01;
  try {
    if (severity === 'warning') {
      leadSynth.triggerAttackRelease(notes[0], '8n', now);
      snareSynth.triggerAttackRelease('16n', now + 0.05);
    } else if (severity === 'error') {
      melodySynth.triggerAttackRelease(notes, '8n', now);
      kickSynth.triggerAttackRelease('C1', '8n', now);
      snareSynth.triggerAttackRelease('8n', now + 0.03);
    } else if (severity === 'critical') {
      melodySynth.triggerAttackRelease(notes, '4n', now);
      leadSynth.triggerAttackRelease(notes[0], '4n', now + 0.02);
      kickSynth.triggerAttackRelease('C1', '4n', now);
      snareSynth.triggerAttackRelease('4n', now + 0.02);
      kickSynth.triggerAttackRelease('C1', '8n', now + 0.2);
    }
  } catch(e) {}
}

// ═══════════════════════════════════════════════
// SEQUENCER PLAYBACK
// ═══════════════════════════════════════════════
function startPlayback() {
  if (!beatData.length) return;
  isPlaying = true; playIndex = 0; chordIndex = 0;
  playBtn.textContent = '⏸';

  // An uploaded track replaces the synthesized instruments entirely —
  // it plays on its own, with the same severity-based distortion/pitch
  // effects applied directly to the real audio, instead of layering the
  // AI-generated bass/pad/lead/drums on top of it.
  const usingUploadedTrack = !!audioBuffer;
  if (usingUploadedTrack) {
    playAudioFile();
  } else {
    initSynths();
    startLoop();
  }

  function tick() {
    if (playIndex >= beatData.length) { playIndex = 0; resetFx(); }
    const beat = beatData[playIndex];

    document.querySelectorAll('.cb-beat').forEach((el, i) =>
      el.classList.toggle('cb-beat--active', i === playIndex)
    );

    // Highlight active line in Monaco
    highlightActiveLine(beat.line);

    if (beat.severity === 'clean') {
      resetFx();
    } else {
      applyFx(beat.severity);
      // accentBeat() triggers extra synth notes — skip it when an
      // uploaded track is carrying the audio instead.
      if (!usingUploadedTrack) accentBeat(beat.severity);
    }

    const stayMs = SEVERITY_FX[beat.severity]?.stayMs || 300;
    progressFill.style.width = `${Math.round(((playIndex + 1) / beatData.length) * 100)}%`;
    currentLine.textContent  = `Line ${beat.line}`;
    playIndex++;
    playTimer = setTimeout(tick, stayMs);
  }
  tick();
}

function stopPlayback() {
  isPlaying = false;
  clearTimeout(playTimer);
  stopLoop(); stopAudioFile(); resetFx();
  playBtn.textContent = '▶';
  document.querySelectorAll('.cb-beat').forEach(el => el.classList.remove('cb-beat--active'));
  progressFill.style.width = '0%';
  currentLine.textContent  = '—';
}

playBtn.addEventListener('click', async () => {
  await Tone.start();
  if (audioContext) await audioContext.resume();
  if (isPlaying) stopPlayback(); else startPlayback();
});

stopBtn.addEventListener('click', () => { stopPlayback(); playIndex = 0; });

bpmRange.addEventListener('input', () => {
  bpmVal.textContent = bpmRange.value;
  updateBpmFill();
  if (isPlaying) Tone.Transport.bpm.value = parseInt(bpmRange.value);
});

// ═══════════════════════════════════════════════
// ANALYZE
// ═══════════════════════════════════════════════
analyzeBtn.addEventListener('click', async () => {
  hideError();
  const code = getCode();
  const lang = langSelect.value;
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '⏳ Analyzing…';

  // Kick off the ML complexity call in parallel with the Gemini
  // analysis, but don't await it alongside it. It's a separate backend
  // (Node -> a Python service on :5000) that can be slow to respond or
  // just not running — awaiting both together (as a Promise.all) meant
  // the whole Analyze button, plus the Issues/Rhythm panels, sat on
  // "Analyzing…" until BOTH finished, even though only the Gemini
  // result is needed for the core feature. Starting it here without an
  // await means it's already in flight, but it no longer holds up
  // anything below — the ML panel fills in on its own once it settles.
  const mlPromise = fetchComplexity(code, lang);

  try {
    const lines = await analyzeWithBackend(code, lang);
    beatData = lines;
    renderSequencer(lines);
    renderIssues(lines.filter(l => l.severity !== 'clean'));
    updateStats(lines);
    highlightEditorLines(lines);
    // ✅ Save analysis session to history
    await saveAnalysisToHistory(code, lang, lines);
  } catch (err) {
    showError(err.message || 'Analysis failed. Try again.');
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<span class="cb-btn__icon">▶</span> Analyze';
    updateAnalyzeBtn();
  }

  renderMlComplexity(await mlPromise);
});

async function analyzeWithBackend(code, lang) {
  let res;
  try {
    res = await fetch(`${BACKEND_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, lang })
    });
  } catch(e) {
    throw new Error('Cannot reach the server. Is the backend running?');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Server error (HTTP ${res.status})`);
  const lines = data?.lines;
  if (!Array.isArray(lines) || !lines.length) throw new Error('Server returned no data. Try again.');
  return lines;
}

// ═══════════════════════════════════════════════
// RUN / OUTPUT PANEL (code execution via paiza.io's free guest runner)
// ═══════════════════════════════════════════════
// TypeScript isn't offered by paiza.io's guest runner, so it's left out
// here (and on the backend) — Run shows a specific message for it below.
const RUNNABLE_LANGS = new Set(['javascript', 'python', 'java', 'cpp', 'rust', 'go']);

function escOutputHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function showOutputPanel()  { outputPanel.hidden = false; }
function closeOutputPanel() { outputPanel.hidden = true; }

function renderOutputLoading() {
  outputStatus.textContent = '…';
  outputStatus.className = 'cb-badge';
  outputMeta.textContent = '';
  outputBody.innerHTML = `
    <div class="cb-empty-state">
      <span class="cb-empty-state__icon">⏳</span>
      <span>Running…</span>
    </div>`;
}

function renderOutputError(message) {
  outputStatus.textContent = 'Error';
  outputStatus.className = 'cb-badge cb-badge--error';
  outputMeta.textContent = '';
  outputBody.innerHTML = `<div class="cb-output-block__text cb-output-block__text--stderr">${escOutputHtml(message)}</div>`;
}

function renderOutputResult(result) {
  const ok = result.statusId === 3; // 3 = success (matches the backend's Accepted mapping)
  outputStatus.textContent = result.status || 'Done';
  outputStatus.className = 'cb-badge ' + (ok ? 'cb-badge--ok' : 'cb-badge--error');

  const metaParts = [];
  if (result.time)   metaParts.push(`${result.time}s`);
  if (result.memory) metaParts.push(`${Math.round(result.memory / 1024)}MB`);
  outputMeta.textContent = metaParts.join(' · ');

  const blocks = [];
  if (result.compileOutput?.trim()) {
    blocks.push(`<div><div class="cb-output-block__label">Compile output</div>
      <div class="cb-output-block__text cb-output-block__text--stderr">${escOutputHtml(result.compileOutput)}</div></div>`);
  }
  if (result.stdout?.trim()) {
    blocks.push(`<div><div class="cb-output-block__label">stdout</div>
      <div class="cb-output-block__text">${escOutputHtml(result.stdout)}</div></div>`);
  }
  if (result.stderr?.trim()) {
    blocks.push(`<div><div class="cb-output-block__label">stderr</div>
      <div class="cb-output-block__text cb-output-block__text--stderr">${escOutputHtml(result.stderr)}</div></div>`);
  }
  if (!blocks.length) {
    blocks.push(`<div class="cb-empty-state"><span class="cb-empty-state__icon">✓</span><span>Ran with no output</span></div>`);
  }
  outputBody.innerHTML = blocks.join('');
}

if (runBtn) {
  runBtn.addEventListener('click', async () => {
    const code = getCode();
    const lang = langSelect.value;

    if (!RUNNABLE_LANGS.has(lang)) {
      showOutputPanel();
      renderOutputError(
        lang === 'typescript'
          ? "TypeScript can't be run directly — try JavaScript instead."
          : 'Pick a specific language (not Auto-detect) before running.'
      );
      return;
    }

    showOutputPanel();
    renderOutputLoading();
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="cb-btn__icon">⏳</span> Running…';

    try {
      const res = await fetch(`${BACKEND_URL}/execute`, {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ code, lang })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Server error (HTTP ${res.status})`);
      renderOutputResult(data);
    } catch (err) {
      renderOutputError(err.message || 'Could not run the code. Try again.');
    } finally {
      runBtn.disabled = getCode().trim().length === 0;
      runBtn.innerHTML = '<span class="cb-btn__icon">▶</span> Run';
    }
  });
}

if (outputCloseBtn) outputCloseBtn.addEventListener('click', closeOutputPanel);

// ═══════════════════════════════════════════════
// ML COMPLEXITY (RF + NN + CodeBERT ensemble)
// ═══════════════════════════════════════════════
// Calls the /complexity route, which the Node backend proxies to the
// separate Python ML service on :5000. That service — and its models —
// exist and were trained, but nothing in the UI ever called it, so
// this always silently returned nothing. Resolves to null (never
// throws) so a slow or offline ML service can't break the main
// Gemini-based Analyze flow it runs alongside.
async function fetchComplexity(code, lang) {
  try {
    const res = await fetch(`${BACKEND_URL}/complexity`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, lang })
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('ML complexity unavailable:', data?.error || res.status);
      return null;
    }
    return data;
  } catch (err) {
    console.warn('Could not reach ML complexity service:', err.message);
    return null;
  }
}

function renderMlComplexity(result) {
  if (!mlComplexityEl || !mlUnavailableEl) return;
  if (!result) {
    mlComplexityEl.hidden  = true;
    mlUnavailableEl.hidden = false;
    return;
  }
  mlUnavailableEl.hidden = true;
  mlComplexityEl.hidden  = false;

  const risk = result.risk_level || 'low';
  mlRiskBadge.textContent = risk.replace('_', ' ');
  mlRiskBadge.className   = `cb-ml__badge cb-ml__badge--${risk}`;
  mlScore.textContent     = `${Math.round((result.fusion_score || 0) * 100)}% complexity`;
  mlLang.textContent      = result.language_used || '';
  mlSummary.textContent   = result.summary || '';
}

// ═══════════════════════════════════════════════
// SAVE ANALYSIS TO HISTORY
// ═══════════════════════════════════════════════
async function saveAnalysisToHistory(code, lang, lines) {
  try {
    // ── Compute counts ──────────────────────────
    const cleanCount    = lines.filter(l => l.severity === 'clean').length;
    const warningCount  = lines.filter(l => l.severity === 'warning').length;
    const errorCount    = lines.filter(l => l.severity === 'error').length;
    const criticalCount = lines.filter(l => l.severity === 'critical').length;
    const issuesFound   = warningCount + errorCount + criticalCount;
    const totalLines    = lines.length;

    // ── Compute fusion score ────────────────────
    // Weighted: warning=0.1, error=0.3, critical=0.6
    const rawScore = totalLines > 0
      ? ((warningCount * 0.1) + (errorCount * 0.3) + (criticalCount * 0.6)) / totalLines
      : 0;
    const fusionScore = Math.min(parseFloat(rawScore.toFixed(4)), 1.0);

    // ── Determine risk level ────────────────────
    let riskLevel = 'low';
    if      (fusionScore >= 0.76) riskLevel = 'critical';
    else if (fusionScore >= 0.51) riskLevel = 'high';
    else if (fusionScore >= 0.26) riskLevel = 'medium';

    // ── Build issues array ──────────────────────
    const issues = lines
      .filter(l => l.severity !== 'clean')
      .map(l => ({
        line_number:  l.line,
        severity:     l.severity,
        description:  l.message || '',
        code_snippet: ''
      }));

    // ── Build beat grid array ───────────────────
    const beatGrid = lines.map((l, i) => ({
      line_number:   l.line,
      severity:      l.severity,
      beat_position: i
    }));

    // ── POST to backend ─────────────────────────
    const res = await fetch(`${BACKEND_URL}/history/save`, {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({
        language:       lang === 'auto' ? 'javascript' : lang,
        total_lines:    totalLines,
        issues_found:   issuesFound,
        clean_count:    cleanCount,
        warning_count:  warningCount,
        error_count:    errorCount,
        critical_count: criticalCount,
        fusion_score:   fusionScore,
        risk_level:     riskLevel,
        code_snippet: code,
        issues:         issues,
        beat_grid:      beatGrid
      })
    });

    if (!res.ok) {
      const data = await res.json();
      console.warn('History save failed:', data?.error || res.status);
    }

  } catch (err) {
    // Silent fail — never interrupt the user experience
    console.warn('Could not save analysis to history:', err.message);
  }
}

// ═══════════════════════════════════════════════
// DEMO SAMPLES
// ═══════════════════════════════════════════════
const DEMOS = {
  clean: { lang: 'javascript', code:
`// Clean code — well-structured, no issues
function calculateArea(width, height) {
  if (width <= 0 || height <= 0) {
    throw new Error('Dimensions must be positive');
  }
  return width * height;
}

function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency
  }).format(amount);
}

function getDiscount(price, percent) {
  const discount = (percent / 100) * price;
  return Math.max(0, price - discount);
}

const area = calculateArea(10, 5);
const price = getDiscount(100, 20);
console.log(formatCurrency(price));`},

  warnings: { lang: 'javascript', code:
`// Minor warnings — works but has bad practices
function getUserData(id) {
  var userData = null
  var url = "http://api.example.com/users/" + id
  fetch(url).then(function(response) {
    return response.json()
  }).then(function(data) {
    userData = data
  })
  return userData
}

function processItems(items) {
  var result = []
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (item != null) result.push(item.name)
  }
  return result
}

var x = 10
var y = 20
console.log(x + y)`},

  errors: { lang: 'javascript', code:
`// Logic errors — incorrect behavior
function calculateTotal(items) {
  let total = 0
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price * items[i].qty
  }
  return totall
}

function applyDiscount(total, discount) {
  if (discount = 0) return total
  return total - (total * discount / 100)
}

function isEven(num) { return num % 2 === 1 }
function reverseString(str) { return str.split('').sort().join('') }

console.log(isEven(4))
console.log(reverseString("hello"))`},

  critical: { lang: 'javascript', code:
`// Critical issues — crashes and security risks
function loginUser(username, password) {
  const query = "SELECT * FROM users WHERE username='" + username + "' AND password='" + password + "'"
  return db.execute(query)
}

function processPayment(user) {
  const card = user.paymentDetails.card
  console.log("Card: " + card.number)
  eval(user.promoCode)
}

function divide(a, b) { return a / b }

const data = null
console.log(data.name)
divide(10, 0)`},

  mixed: { lang: 'javascript', code:
`// Mixed — all severity levels
function fetchUserOrders(userId) {
  var url = "http://api.example.com/orders?user=" + userId
  if (userId = null) return []
  const response = fetch(url)
  const orders = response.json()
  let total = 0
  for (let i = 0; i <= orders.length; i++) {
    total += orders[i].amount
  }
  const query = "SELECT * FROM orders WHERE id=" + userId
  db.execute(query)
  return totaal
}

function formatDate(date) {
  var d = new Date(date)
  return d.toLocaleDateString()
}

const user = null
console.log(user.name)
console.log(fetchUserOrders(42))`}
};

// ═══════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════
function updateAnalyzeBtn() {
  const empty = getCode().trim().length === 0;
  analyzeBtn.disabled = empty;
  if (runBtn) runBtn.disabled = empty;
}

if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    if (monacoEditor) monacoEditor.setValue('');
    lineCount.textContent = '0 lines';
    clearDecorations();
    updateAnalyzeBtn();
    // A failed Analyze (empty code, backend unreachable, etc.) leaves the
    // red error banner up — Clear resets everything else back to a blank
    // slate, so the stale error shouldn't be the one thing left behind.
    hideError();
    if (mlComplexityEl)  mlComplexityEl.hidden  = true;
    if (mlUnavailableEl) mlUnavailableEl.hidden = true;
  });
}

if (demoSelect) {
  demoSelect.addEventListener('change', () => {
    const key  = demoSelect.value;
    if (!key) return;
    const demo = DEMOS[key];
    if (!demo) return;
    langSelect.value = demo.lang;
    setCode(demo.code, demo.lang);
    clearDecorations();
    hideError(); // loading a fresh demo is also a fresh start
    demoSelect.value = '';
  });
}

langSelect.addEventListener('change', () => {
  if (monacoEditor) {
    monaco.editor.setModelLanguage(
      monacoEditor.getModel(),
      getMonacoLang(langSelect.value)
    );
  }
});

function showError(msg) {
  errorBannerMsg.textContent = msg;
  errorBanner.hidden = false;
}
function hideError() {
  errorBanner.hidden = true;
  errorBannerMsg.textContent = '';
}

function renderSequencer(lines) {
  sequencer.innerHTML = '';
  lines.forEach(b => {
    const cell = document.createElement('div');
    cell.className = `cb-beat cb-beat--${b.severity}`;
    cell.setAttribute('role', 'listitem');
    cell.setAttribute('data-line', b.line);
    cell.setAttribute('title', `Line ${b.line}${b.message ? ': ' + b.message : ''}`);
    cell.textContent = b.line;
    cell.addEventListener('click', () => {
      highlightIssue(b.line);
      if (monacoEditor) monacoEditor.revealLineInCenter(b.line);
    });
    sequencer.appendChild(cell);
  });
  playBtn.disabled = false;
  stopBtn.disabled = false;
}

function highlightIssue(lineNum) {
  document.querySelectorAll('.cb-issue').forEach(el => el.style.outline = '');
  const match = issueList.querySelector(`[data-line="${lineNum}"]`);
  if (match) {
    match.style.outline = '2px solid #1de4a8';
    match.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function updateStats(lines) {
  const count = sev => lines.filter(l => l.severity === sev).length;
  document.getElementById('stat-clean').textContent    = count('clean');
  document.getElementById('stat-warning').textContent  = count('warning');
  document.getElementById('stat-error').textContent    = count('error');
  document.getElementById('stat-critical').textContent = count('critical');
}

function renderIssues(issues) {
  issueCount.textContent = issues.length;
  if (!issues.length) {
    issueList.innerHTML = '<div class="cb-empty-state"><span class="cb-empty-state__icon">✓</span><span>No issues found — great code!</span></div>';
    return;
  }
  issueList.innerHTML = issues.map(iss => `
    <div class="cb-issue cb-issue--${iss.severity}" data-line="${iss.line}">
      <span class="cb-issue__line">Line ${iss.line}</span>
      <span class="cb-issue__severity">${iss.severity}</span>
      <p class="cb-issue__msg">${iss.message}</p>
    </div>`).join('');

  issueList.querySelectorAll('.cb-issue').forEach(el => {
    el.addEventListener('click', () => {
      const line = parseInt(el.dataset.line);
      if (monacoEditor) monacoEditor.revealLineInCenter(line);
      document.querySelectorAll('.cb-beat').forEach((beat, i) => {
        beat.classList.toggle('cb-beat--active', beatData[i]?.line === line);
      });
    });
  });
}

// ═══════════════════════════════════════════════
// MONACO INIT — must be last, wraps everything
// ═══════════════════════════════════════════════
require(['vs/editor/editor.main'], function () {

  // Define Codebeat dark theme for Monaco
  monaco.editor.defineTheme('codebeat-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment',   foreground: '4a5060', fontStyle: 'italic' },
      { token: 'keyword',   foreground: '1de4a8', fontStyle: 'bold'   },
      { token: 'string',    foreground: 'e0a36b' },
      { token: 'number',    foreground: 'b5cea8' },
      { token: 'function',  foreground: '7ecfff' },
      { token: 'variable',  foreground: 'e8eaf0' },
      { token: 'type',      foreground: '4ec9b0' },
    ],
    colors: {
      'editor.background':          '#0d0f12',
      'editor.foreground':          '#e8eaf0',
      'editorLineNumber.foreground':'#3a3f4b',
      'editorLineNumber.activeForeground': '#1de4a8',
      'editor.lineHighlightBackground':    '#13161b',
      'editorCursor.foreground':    '#1de4a8',
      'editor.selectionBackground': '#1de4a830',
      'editorGutter.background':    '#0d0f12',
      'scrollbarSlider.background': '#2a2e3880',
      'minimap.background':         '#0d0f12',
    }
  });

  // Define Codebeat light theme for Monaco (mirrors codebeat-dark, but
  // with colors picked for good contrast on a light background)
  monaco.editor.defineTheme('codebeat-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment',   foreground: '8a8f9c', fontStyle: 'italic' },
      { token: 'keyword',   foreground: '0c8f63', fontStyle: 'bold'   },
      { token: 'string',    foreground: 'a1650f' },
      { token: 'number',    foreground: '2f7d5a' },
      { token: 'function',  foreground: '1768c4' },
      { token: 'variable',  foreground: '1b1e24' },
      { token: 'type',      foreground: '0e7a68' },
    ],
    colors: {
      'editor.background':          '#ffffff',
      'editor.foreground':          '#1b1e24',
      'editorLineNumber.foreground':'#a9adb8',
      'editorLineNumber.activeForeground': '#0c8f63',
      'editor.lineHighlightBackground':    '#f0f2f5',
      'editorCursor.foreground':    '#0c8f63',
      'editor.selectionBackground': '#0ea47230',
      'editorGutter.background':    '#ffffff',
      'scrollbarSlider.background': '#d7dbe280',
      'minimap.background':         '#ffffff',
    }
  });

  function monacoThemeForPage() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'codebeat-light' : 'codebeat-dark';
  }

  // Exposed so theme.js can switch Monaco's theme when the page's
  // light/dark toggle is clicked.
  window.setMonacoTheme = function (pageTheme) {
    monaco.editor.setTheme(pageTheme === 'light' ? 'codebeat-light' : 'codebeat-dark');
  };

  // Mount Monaco
  monacoEditor = monaco.editor.create(document.getElementById('monaco-editor'), {
    value:              '',
    language:           'javascript',
    theme:              monacoThemeForPage(),
    fontSize:           13,
    fontFamily:         "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
    lineNumbers:        'on',
    glyphMargin:        true,
    folding:            true,
    minimap:            { enabled: true },
    scrollBeyondLastLine: false,
    automaticLayout:    true,
    wordWrap:           'on',
    renderLineHighlight:'all',
    cursorBlinking:     'smooth',
    smoothScrolling:    true,
    padding:            { top: 12, bottom: 12 },
    suggest:            { showKeywords: true },
    tabSize:            2,
  });

  // Update line count + analyze button on content change
  monacoEditor.onDidChangeModelContent(() => {
    const lines = monacoEditor.getModel().getLineCount();
    lineCount.textContent = `${lines} line${lines !== 1 ? 's' : ''}`;
    updateAnalyzeBtn();
  });

  // Add CSS for Monaco line decorations
  const style = document.createElement('style');
  style.textContent = `
    .monaco-line-warning  { background: #281a0688 !important; }
    .monaco-line-error    { background: #26110a88 !important; }
    .monaco-line-critical { background: #24090988 !important; }
    .monaco-glyph-warning::before  { content: '⚠'; color: #d9921e; font-size: 11px; }
    .monaco-glyph-error::before    { content: '✖'; color: #d45a30; font-size: 11px; }
    .monaco-glyph-critical::before { content: '💀'; font-size: 10px; }
  `;
  document.head.appendChild(style);

  // Ready!
  updateAnalyzeBtn();
});