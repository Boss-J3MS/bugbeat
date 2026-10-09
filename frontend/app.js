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

// ── Audio output buffering ─────────────────────
// Browsers default to the smallest audio buffer ('interactive' latency),
// meant for games and instruments that must respond instantly. On a busy
// laptop, or with Bluetooth/USB audio, that small buffer can run dry: the
// audio clock falls behind and the sound drops out for a while even though
// the music is still being generated. BugBeat only plays background music,
// so it asks for the larger 'playback' buffer instead — sound starts a
// fraction of a second later, but plays through without gaps. This has to
// run before any instrument is created (they're built when Play is pressed).
// Note: after this, use Tone.getTransport() / Tone.getDestination(), not
// Tone.Transport / Tone.Destination — those still point at the old context.
if (window.Tone) {
  try {
    Tone.setContext(new Tone.Context({ latencyHint: 'playback', lookAhead: 0.15 }));
  } catch (e) {
    console.warn('Could not switch audio to playback buffering:', e.message);
  }
}

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
      // Broadcasts are stored as "title\nmessage"; show them on one line.
      msg.textContent = String(n.message || '').replace(/\s*\n\s*/, ' — ');

      const time = document.createElement('span');
      time.className = 'cb-notif__item-time';
      time.textContent = timeAgo(n.created_at);

      item.append(msg, time);
      // Opens the notification in the full view (notif-view.js), which
      // also marks it read.
      const open = () => {
        closeNotifDropdown();
        if (window.openNotification) openNotification(n);
        else markNotificationRead(n.id);
      };
      item.addEventListener('click', open);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
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

function closeNotifDropdown() {
  if (!notifDropdown || notifDropdown.hidden) return;
  notifDropdown.hidden = true;
  notifBtn?.setAttribute('aria-expanded', 'false');
}

const notifViewAll = document.getElementById('notif-view-all');
if (notifViewAll) {
  notifViewAll.addEventListener('click', () => {
    closeNotifDropdown();
    if (window.openAllNotifications) openAllNotifications();
  });
}

if (notifBtn && notifDropdown && notifWrap) {
  // No stopPropagation here: the ☰ menu closes itself on any click
  // outside it (menu.js), and stopping this click kept it open on top of
  // this dropdown. Clicks inside #notif-wrap are ignored by the
  // close-on-outside-click listener below anyway.
  notifBtn.addEventListener('click', () => {
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
const musicStatus    = document.getElementById('music-status');
const styleSelect    = document.getElementById('style-select');
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

// Display names for the language list values.
const LANG_LABELS = {
  javascript: 'JavaScript', python: 'Python', typescript: 'TypeScript',
  java: 'Java', cpp: 'C++', rust: 'Rust', go: 'Go'
};

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
let currentTrackName = null;   // name of the uploaded/saved track in use
let audioAnalyser  = null;     // level meter on the uploaded track

// Longest track that can be loaded. The browser unpacks the whole song
// into memory to apply the error effects (about 20 MB per minute), so
// very long files could crash the tab.
const MAX_TRACK_SECONDS = 10 * 60;

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
// Decodes a track and makes it the backing track. Used for a freshly
// picked file and for a saved track from "My tracks" (tracks.js).
// Returns true if the audio could be decoded.
async function useAudioTrack(arrayBuffer, name) {
  try {
    // Same larger 'playback' buffer for uploaded tracks (see above).
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    if (decoded.duration > MAX_TRACK_SECONDS) {
      showTooLongNotice(name, decoded.duration);
      return false;
    }
    audioBuffer = decoded;
    currentTrackName = name;
    audioLabel.textContent = `🎵 ${name}`;
    audioRemoveBtn.hidden  = false;
    setMusicStatus(`✅ "${name}" loaded — replaces the synthesized music, with error effects applied directly to it`, 'ok');
    updateNowPlaying();
    return true;
  } catch(err) {
    setMusicStatus('⚠ Could not decode audio file. Try an MP3 or WAV.', 'error');
    return false;
  }
}

function formatMinutes(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showTooLongNotice(name, seconds) {
  showNotice({
    title: 'Song is too long',
    message: `"${name}" is ${formatMinutes(seconds)} long. BugBeat can play songs up to ${MAX_TRACK_SECONDS / 60} minutes. ` +
             'Please choose a shorter song or trim this one.'
  });
}

// Reads just the file's length (without unpacking the whole song), so a
// too-long file is turned away before it can use up the browser's memory.
// Resolves to the length in seconds, or null if the browser can't tell.
function getAudioDuration(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      probe.removeAttribute('src');
      resolve(value);
    };
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : null);
    probe.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    probe.src = url;
  });
}

if (audioUpload) {
  audioUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const seconds = await getAudioDuration(file);
    if (seconds && seconds > MAX_TRACK_SECONDS) {
      showTooLongNotice(file.name, seconds);
      audioUpload.value = '';
      return;
    }
    uploadedFile = file;
    const ok = await useAudioTrack(await file.arrayBuffer(), file.name);
    // Also keep it in the user's saved tracks (tracks.js).
    if (ok && window.saveTrackToAccount) saveTrackToAccount(file);
    // Clear the picker so choosing the same file again still works (e.g.
    // re-uploading a song after deleting a saved track to make room).
    audioUpload.value = '';
  });
}

if (audioRemoveBtn) {
  audioRemoveBtn.addEventListener('click', () => {
    uploadedFile = null; audioBuffer = null; currentTrackName = null;
    audioUpload.value = '';
    audioLabel.textContent = 'Upload audio';
    audioRemoveBtn.hidden  = true;
    setMusicStatus('Audio removed — using synthesized music', '');
    stopAudioFile();
    if (window.markActiveTrack) markActiveTrack(null);
    updateNowPlaying();
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
  // Level meter for the waveform pulse (see startWavePulse).
  audioAnalyser = audioContext.createAnalyser();
  audioAnalyser.fftSize = 1024;
  audioGain.connect(audioAnalyser);
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
// MUSIC STYLE (☰ menu → Sound → Music style)
// ═══════════════════════════════════════════════
// Ready-made styles for the generated music, played when no track is
// uploaded. Each one only lists what differs from the Lo-fi default.
const STYLE_PRESETS = {
  lofi: { ...DEFAULT_STYLE, name: 'Lo-fi Chill' },

  jazz: {
    ...DEFAULT_STYLE,
    name: 'Smooth Jazz',
    description: 'Mellow ii–V–I changes with a soft ride cymbal',
    bpm: 100,
    oscillatorType: 'sine',
    chordProgression: [['D3','F3','A3','C4'],['G2','B2','D3','F3'],['C3','E3','G3','B3'],['A2','C3','E3','G3']],
    bassLine:  ['D2','F2','G2','B1','C2','E2','A1','C2'],
    padChords: [['F4','A4','C5'],['B3','D4','F4'],['E4','G4','B4'],['C4','E4','G4']],
    leadNotes: ['A4','C5','D5','E5','G5','A5','B5','D6'],
    chordMap:  { clean: ['C4','E4'], warning: ['F4','B4'], error: ['Eb3','A3'], critical: ['C3','F#3'] },
    envelope:  { attack: 0.02, decay: 0.4, sustain: 0.3, release: 1.0 },
    reverbWet: 0.35,
    chorusWet: 0.15,
    volume:    -13,
    loopPattern: {
      kick:    [1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0],
      snare:   [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1],
      hihat:   [1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1],
      openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
    },
    drumKit: { kickPitchDecay: 0.05, kickOctaves: 6, snareNoiseType: 'pink', hihatFrequency: 300, hihatDecay: 0.08 }
  },

  rock: {
    ...DEFAULT_STYLE,
    name: 'Rock Drive',
    description: 'Driving power chords and a straight backbeat',
    bpm: 125,
    oscillatorType: 'sawtooth',
    chordProgression: [['E3','B3','E4'],['C3','G3','C4'],['G2','D3','G3'],['D3','A3','D4']],
    bassLine:  ['E2','E2','C2','C2','G1','G1','D2','D2'],
    padChords: [['E4','G4','B4'],['C4','E4','G4'],['G3','B3','D4'],['D4','F#4','A4']],
    leadNotes: ['E4','G4','A4','B4','D5','E5','G5','B5'],
    chordMap:  { clean: ['E4','B4'], warning: ['F4','C5'], error: ['Bb3','E4'], critical: ['E3','Bb3'] },
    envelope:  { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4 },
    reverbWet: 0.2,
    chorusWet: 0.1,
    volume:    -17,
    loopPattern: {
      kick:    [1,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0],
      snare:   [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
      hihat:   [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0],
      openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0]
    },
    drumKit: { kickPitchDecay: 0.05, kickOctaves: 6, snareNoiseType: 'white', hihatFrequency: 500, hihatDecay: 0.03 }
  },

  electronic: {
    ...DEFAULT_STYLE,
    name: 'Electronic Pulse',
    description: 'Four-on-the-floor beat with an offbeat bass',
    bpm: 124,
    oscillatorType: 'square',
    chordProgression: [['A2','C3','E3'],['F2','A2','C3'],['C3','E3','G3'],['G2','B2','D3']],
    bassLine:  ['A1','A2','F1','F2','C2','C3','G1','G2'],
    padChords: [['A3','C4','E4'],['F3','A3','C4'],['C4','E4','G4'],['G3','B3','D4']],
    leadNotes: ['A4','C5','E5','G5','A5','C6','E6','G5'],
    chordMap:  { clean: ['A4','E5'], warning: ['G#4','D5'], error: ['D#4','A4'], critical: ['A3','D#4'] },
    envelope:  { attack: 0.005, decay: 0.15, sustain: 0.4, release: 0.3 },
    reverbWet: 0.3,
    chorusWet: 0.3,
    volume:    -18,
    loopPattern: {
      kick:    [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],
      snare:   [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0],
      hihat:   [0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0],
      openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0]
    },
    drumKit: { kickPitchDecay: 0.03, kickOctaves: 10, snareNoiseType: 'white', hihatFrequency: 600, hihatDecay: 0.02 }
  },

  ambient: {
    ...DEFAULT_STYLE,
    name: 'Ambient Calm',
    description: 'Slow, airy chords with very light percussion',
    bpm: 70,
    oscillatorType: 'sine',
    chordProgression: [['C3','E3','G3','B3'],['A2','C3','E3','G3'],['F2','A2','C3','E3'],['G2','B2','D3','E3']],
    bassLine:  ['C2','C2','A1','A1','F1','F1','G1','G1'],
    padChords: [['E4','G4','B4'],['C4','E4','G4'],['A3','C4','E4'],['B3','D4','G4']],
    leadNotes: ['E5','G5','B5','C6','D6','E6','G6','B5'],
    chordMap:  { clean: ['C5','G5'], warning: ['B4','F5'], error: ['F4','B4'], critical: ['C4','F#4'] },
    envelope:  { attack: 0.4, decay: 0.5, sustain: 0.7, release: 2.0 },
    reverbWet: 0.7,
    chorusWet: 0.4,
    volume:    -16,
    loopPattern: {
      kick:    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      snare:   [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      hihat:   [0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0],
      openHat: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
    },
    drumKit: { kickPitchDecay: 0.08, kickOctaves: 5, snareNoiseType: 'pink', hihatFrequency: 250, hihatDecay: 0.05 }
  }
};
const STYLE_KEY = 'cb-music-style';

// Switches the generated music to a preset. Rebuilds the instruments
// (and restarts playback if it was playing) so the change is heard
// straight away.
function applyMusicStyle(key, { announce = true } = {}) {
  const preset = STYLE_PRESETS[key] || STYLE_PRESETS.lofi;
  currentStyle = preset;
  bpmRange.value = preset.bpm;
  bpmVal.textContent = preset.bpm;
  updateBpmFill();

  const wasPlaying = isPlaying;
  if (wasPlaying) stopPlayback();
  if (synthsReady) teardownSynths();
  if (wasPlaying) startPlayback();

  try { localStorage.setItem(STYLE_KEY, key); } catch (e) {}
  updateNowPlaying();
  if (announce) {
    setMusicStatus(
      audioBuffer
        ? `🎵 ${preset.name} selected — remove your uploaded track to hear it`
        : `🎵 ${preset.name} — ${preset.description}`,
      'ok'
    );
  }
}

if (styleSelect) {
  let saved = 'lofi';
  try { saved = localStorage.getItem(STYLE_KEY) || 'lofi'; } catch (e) {}
  if (!STYLE_PRESETS[saved]) saved = 'lofi';
  styleSelect.value = saved;
  applyMusicStyle(saved, { announce: false });
  styleSelect.addEventListener('change', () => applyMusicStyle(styleSelect.value));
}

// ── "Now playing" line in the Playback panel ───
// Always shows what Play will use: the user's track, or the generated
// music style.
function updateNowPlaying() {
  const nameEl = document.getElementById('now-playing-name');
  const kindEl = document.getElementById('now-playing-kind');
  if (!nameEl || !kindEl) return;
  if (audioBuffer && currentTrackName) {
    nameEl.textContent = `🎵 ${currentTrackName}`;
    nameEl.title = currentTrackName;
    kindEl.textContent = 'Your track';
  } else {
    const opt = styleSelect?.selectedOptions?.[0];
    const label = opt ? opt.textContent.trim() : (getStyle().name || 'Generated music');
    nameEl.textContent = label;
    nameEl.title = label;
    kindEl.textContent = 'Generated';
  }
}

// ── Notice pop-up ──────────────────────────────
// A simple message box (title, text, OK, and an optional extra button).
// Built once on first use; shared with tracks.js.
function showNotice({ title, message, actionLabel, onAction }) {
  let modal = document.getElementById('notice-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'notice-modal';
    modal.className = 'cb-bugreport-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'notice-title');
    modal.innerHTML = `
      <div class="cb-bugreport-modal__box cb-notice">
        <div class="cb-bugreport-modal__header">
          <span id="notice-title" class="cb-bugreport-modal__title"></span>
          <button type="button" class="cb-btn cb-btn--ghost" data-notice-close title="Close" aria-label="Close">✕</button>
        </div>
        <p id="notice-msg" class="cb-bugreport-modal__hint cb-notice__msg"></p>
        <div class="cb-bugreport-modal__actions">
          <button type="button" id="notice-action" class="cb-btn cb-btn--primary" hidden></button>
          <button type="button" id="notice-ok" class="cb-btn cb-btn--ghost" data-notice-close>OK</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => { modal.hidden = true; };
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-notice-close]')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  }
  modal.querySelector('#notice-title').textContent = title || '';
  modal.querySelector('#notice-msg').textContent = message || '';
  const action = modal.querySelector('#notice-action');
  if (actionLabel && onAction) {
    action.textContent = actionLabel;
    action.hidden = false;
    action.onclick = () => {
      modal.hidden = true;
      // After this click has finished (it would otherwise also count as
      // a click outside the ☰ menu and close it again).
      setTimeout(onAction, 0);
    };
  } else {
    action.hidden = true;
    action.onclick = null;
  }
  modal.hidden = false;
  modal.querySelector('#notice-ok').focus();
}

function setMusicStatus(msg, state) {
  if (!musicStatus) return;
  musicStatus.textContent = msg;
  musicStatus.className   = 'cb-music-status' + (state ? ' cb-music-status--' + state : '');
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

  Tone.getTransport().bpm.value = parseInt(bpmRange.value);

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
  Tone.getTransport().start();
  toneLoop = { bassSeq, padSeq, melodySeq, leadSeq, drumSeq };
}

function stopLoop() {
  if (toneLoop) {
    Object.values(toneLoop).forEach(seq => { try { seq?.stop(); seq?.dispose(); } catch(e) {} });
  }
  try { Tone.getTransport().stop(); Tone.getTransport().cancel(); } catch(e) {}
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
  startPositionDisplay();
  startWavePulse();

  function tick() {
    if (playIndex >= beatData.length) { playIndex = 0; resetFx(); }
    const beat = beatData[playIndex];

    document.querySelectorAll('.cb-beat').forEach((el, i) =>
      el.classList.toggle('cb-beat--active', i === playIndex)
    );
    showWaveInfo(beat, { scroll: true });

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
  stopPositionDisplay();
  stopWavePulse();
  showWaveInfo(null);
}

// ── Playback position (progress bar + label) ───
// Shows where the music is, not which code line is playing:
//  • uploaded track → song time, e.g. "1:23 / 3:45" (the bar fills over
//    the whole song, then starts again when the track loops)
//  • generated music → "Bar 3 · Beat 2" (the bar fills over each 4-bar
//    phrase, the length of the generated chord loop)
// The current code line is still highlighted in the editor and beat grid.
const PHRASE_BARS = 4;
let positionTimer = null;
let trackPos = 0;        // seconds into the uploaded track
let trackLastT = 0;      // audioContext time of the last update
let lastProgress = 0;

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setProgress(fraction, label) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  // Jump straight back to the start when it wraps, instead of animating
  // backwards across the bar.
  progressFill.style.transition = pct < lastProgress ? 'none' : '';
  progressFill.style.width = `${pct.toFixed(1)}%`;
  progressFill.parentElement?.setAttribute('aria-valuenow', String(Math.round(pct)));
  lastProgress = pct;
  currentLine.textContent = label;
}

function updatePositionDisplay() {
  if (audioSource && audioBuffer && audioContext) {
    // The track's speed changes with the error effects, so add up the
    // time actually played at each speed.
    const now = audioContext.currentTime;
    trackPos += (now - trackLastT) * audioSource.playbackRate.value;
    trackLastT = now;
    const dur = audioBuffer.duration || 0;
    if (dur > 0) trackPos %= dur;
    setProgress(dur ? trackPos / dur : 0, `${formatTime(trackPos)} / ${formatTime(dur)}`);
    return;
  }
  const transport = (typeof Tone !== 'undefined') ? Tone.getTransport() : null;
  if (transport && transport.state === 'started') {
    const beatsPerBar = Number(transport.timeSignature) || 4;
    const quarters    = transport.ticks / transport.PPQ;
    const bar         = Math.floor(quarters / beatsPerBar);
    const beat        = Math.floor(quarters % beatsPerBar);
    const inPhrase    = (quarters % (PHRASE_BARS * beatsPerBar)) / (PHRASE_BARS * beatsPerBar);
    setProgress(inPhrase, `Bar ${bar + 1} · Beat ${beat + 1}`);
  }
}

function startPositionDisplay() {
  stopPositionDisplay(false);
  trackPos   = 0;
  trackLastT = audioContext ? audioContext.currentTime : 0;
  updatePositionDisplay();
  positionTimer = setInterval(updatePositionDisplay, 100);
}

function stopPositionDisplay(reset = true) {
  clearInterval(positionTimer);
  positionTimer = null;
  if (reset) {
    lastProgress = 0;
    setProgress(0, '—');
  }
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
  if (isPlaying) Tone.getTransport().bpm.value = parseInt(bpmRange.value);
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
    const { lines, language } = await analyzeWithBackend(code, lang);
    // A picked language stays as it is. With Auto-detect, show what was
    // detected, switch the editor's highlighting to it, and save it to
    // History (instead of always saving "javascript").
    let savedLang = lang;
    if (lang !== 'auto' && LANG_LABELS[lang]) {
      setMusicStatus(`✓ Checked as ${LANG_LABELS[lang]}`, '');
    }
    if (lang === 'auto') {
      const name = LANG_LABELS[language];
      if (name) {
        savedLang = language;
        if (monacoEditor) monaco.editor.setModelLanguage(monacoEditor.getModel(), getMonacoLang(language));
        setMusicStatus(`🔍 Detected language: ${name}`, 'ok');
      } else {
        savedLang = 'javascript';   // same fallback History always used
        setMusicStatus('🔍 Could not tell which language this is — pick it from the list for a stricter check', '');
      }
    }
    beatData = lines;
    renderSequencer(lines);
    renderIssues(lines.filter(l => l.severity !== 'clean'));
    updateStats(lines);
    highlightEditorLines(lines);
    // ✅ Save analysis session to history
    await saveAnalysisToHistory(code, savedLang, lines);
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
  return { lines, language: data.language || lang };
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
        code_snippet: '',
        suggestion:   l.suggestion || '',
        fix:          l.fix || ''
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

// ── Rhythm panel: waveform ─────────────────────
// One bar per code line. Bar height and colour show the severity (clean
// short → critical tallest). Hovering/focusing a bar shows its line below
// the wave; clicking it jumps to that line. While music plays, the bar
// being played lights up and all bars pulse with the music's volume.
const SEVERITY_LABEL = { clean: 'Clean', warning: 'Warning', error: 'Error', critical: 'Critical' };
let waveHoverLine = null;   // line under the mouse/keyboard focus, if any

function waveSummary() {
  const issues = beatData.filter(b => b.severity !== 'clean').length;
  return `${beatData.length} line${beatData.length === 1 ? '' : 's'} · ` +
         `${issues} issue${issues === 1 ? '' : 's'} — hover a bar to see its line`;
}

// Shows one line's details under the wave (or the summary when beat is
// null). While hovering, the hovered bar wins over the playing one.
function showWaveInfo(beat, { scroll = false, fromHover = false } = {}) {
  const info = document.getElementById('wave-info');
  if (!info) return;
  if (!fromHover && waveHoverLine !== null) return;
  if (!beat) {
    info.className = 'cb-wave__info';
    info.textContent = beatData.length ? waveSummary() : '';
    return;
  }
  info.className = `cb-wave__info cb-wave__info--${beat.severity}`;
  info.textContent = `Line ${beat.line} · ${SEVERITY_LABEL[beat.severity] || beat.severity}` +
                     (beat.message ? ` — ${beat.message}` : '');
  if (scroll) {
    const bar = sequencer.querySelector(`.cb-beat[data-line="${beat.line}"]`);
    const wave = sequencer.querySelector('.cb-wave');
    if (bar && wave) {
      // Keep it in view horizontally without scrolling the whole page.
      const left = bar.offsetLeft - wave.clientWidth / 2 + bar.offsetWidth / 2;
      wave.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
  }
}

function renderSequencer(lines) {
  sequencer.innerHTML = '';
  const wave = document.createElement('div');
  wave.className = 'cb-wave';
  const bars = document.createElement('div');
  bars.className = 'cb-wave__bars';

  lines.forEach((b, i) => {
    const bar = document.createElement('div');
    bar.className = `cb-beat cb-beat--${b.severity}`;
    bar.setAttribute('role', 'listitem');
    bar.setAttribute('data-line', b.line);
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-label', `Line ${b.line}, ${SEVERITY_LABEL[b.severity] || b.severity}${b.message ? ': ' + b.message : ''}`);
    bar.title = `Line ${b.line} · ${SEVERITY_LABEL[b.severity] || b.severity}${b.message ? ' — ' + b.message : ''}`;
    // How strongly this bar reacts to the volume pulse (varies per bar so
    // the wave moves like an equalizer instead of all at once).
    bar.style.setProperty('--k', (0.3 + ((i * 37) % 11) / 20).toFixed(2));

    const jump = () => {
      highlightIssue(b.line);
      if (monacoEditor) monacoEditor.revealLineInCenter(b.line);
    };
    bar.addEventListener('click', jump);
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); }
    });
    const hoverOn  = () => { waveHoverLine = b.line; showWaveInfo(b, { fromHover: true }); };
    const hoverOff = () => {
      waveHoverLine = null;
      const playing = isPlaying ? beatData[(playIndex - 1 + beatData.length) % beatData.length] : null;
      showWaveInfo(playing);
    };
    bar.addEventListener('mouseenter', hoverOn);
    bar.addEventListener('focus', hoverOn);
    bar.addEventListener('mouseleave', hoverOff);
    bar.addEventListener('blur', hoverOff);
    bars.appendChild(bar);
  });

  wave.appendChild(bars);
  const info = document.createElement('div');
  info.id = 'wave-info';
  info.className = 'cb-wave__info';
  info.setAttribute('aria-live', 'polite');
  sequencer.append(wave, info);
  waveHoverLine = null;
  showWaveInfo(null);

  playBtn.disabled = false;
  stopBtn.disabled = false;
}

// ── Waveform pulse ─────────────────────────────
// Reads the music's volume about 30 times a second and passes it to the
// bars as --pulse (0–1). Skipped for users who prefer reduced motion.
let pulseFrame = null;
let pulseMeter = null;
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

function currentLevel() {
  if (audioSource && audioAnalyser) {
    const data = new Float32Array(audioAnalyser.fftSize);
    audioAnalyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.min(1, Math.sqrt(sum / data.length) * 3.5);
  }
  if (typeof Tone !== 'undefined') {
    if (!pulseMeter) {
      try {
        pulseMeter = new Tone.Meter({ normalRange: true, smoothing: 0.7 });
        Tone.getDestination().connect(pulseMeter);
      } catch (e) { return 0; }
    }
    const v = pulseMeter.getValue();
    return Math.min(1, (Array.isArray(v) ? Math.max(...v) : v) * 2.5);
  }
  return 0;
}

function startWavePulse() {
  stopWavePulse();
  if (reduceMotion?.matches) return;
  let last = 0;
  const step = (t) => {
    if (t - last > 33) {
      last = t;
      const wave = sequencer.querySelector('.cb-wave');
      if (wave) wave.style.setProperty('--pulse', currentLevel().toFixed(3));
    }
    pulseFrame = requestAnimationFrame(step);
  };
  pulseFrame = requestAnimationFrame(step);
}

function stopWavePulse() {
  if (pulseFrame) cancelAnimationFrame(pulseFrame);
  pulseFrame = null;
  sequencer.querySelector('.cb-wave')?.style.setProperty('--pulse', '0');
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
  // Text from the AI is escaped before it goes into the page.
  const esc = escOutputHtml;
  issueList.innerHTML = issues.map((iss, i) => `
    <div class="cb-issue cb-issue--${esc(iss.severity)}" data-line="${Number(iss.line) || 0}">
      <span class="cb-issue__line">Line ${Number(iss.line) || 0}</span>
      <span class="cb-issue__severity">${esc(iss.severity)}</span>
      <p class="cb-issue__msg">${esc(iss.message)}</p>
      ${iss.suggestion ? `
        <div class="cb-issue__suggest">
          <span class="cb-issue__suggest-label">💡 How to fix</span>
          <p class="cb-issue__suggest-text">${esc(iss.suggestion)}</p>
        </div>` : ''}
      ${iss.fix ? `
        <div class="cb-issue__fix">
          <pre class="cb-issue__fix-code"><code>${esc(iss.fix)}</code></pre>
          <button type="button" class="cb-issue__copy" data-fix="${i}" title="Copy the fixed line">Copy</button>
        </div>` : ''}
    </div>`).join('');

  // Copy the suggested line (without jumping to the line in the editor).
  issueList.querySelectorAll('.cb-issue__copy').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = issues[Number(btn.dataset.fix)]?.fix || '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied!';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });

  issueList.querySelectorAll('.cb-issue').forEach(el => {
    el.addEventListener('click', () => {
      const line = parseInt(el.dataset.line);
      if (monacoEditor) monacoEditor.revealLineInCenter(line);
      document.querySelectorAll('.cb-beat').forEach((beat, i) => {
        beat.classList.toggle('cb-beat--active', beatData[i]?.line === line);
      });
      const b = beatData.find(x => x.line === line);
      if (b) showWaveInfo(b, { scroll: true });
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