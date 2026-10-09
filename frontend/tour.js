// ═══════════════════════════════════════════════
//  tour.js — guided tour for first-time users (index.html)
//  Highlights one part of the page at a time with a short explanation
//  card (Back / Next / Skip). It starts by itself the first time a user
//  opens BugBeat on a browser, and can be replayed any time from
//  "Take the tour" in the sidebar.
//  Keyboard: → / Enter = next, ← = back, Esc = close.
// ═══════════════════════════════════════════════
(function () {
  // Each step points at an element (target) — or none, for a centred
  // card. Steps marked `sidebar: true` open the sidebar while they are
  // shown (it goes back to how it was afterwards). Steps whose element
  // isn't on screen right now (e.g. the resize handles on a phone, or
  // Admin for normal users) are skipped automatically.
  const STEPS = [
    // ── Getting started ──
    { title: 'Welcome to BugBeat 🐞🎵',
      text: 'BugBeat turns problems in your code into music, so you can hear bugs as well as see them. This tour takes about a minute. Use the arrow keys or the buttons to move around.' },
    { target: '#brand-link', title: 'Home',
      text: 'Click the BugBeat logo any time for a fresh start. It refreshes the page and clears the editor, so finish or copy your code first.' },

    // ── Checking code ──
    { target: '.cb-panel--editor', title: 'Write or paste code',
      text: 'Type or paste the code you want to check here. The line count is shown at the top right.' },
    { target: '#lang-select', title: 'Pick the language',
      text: 'Choose your code\'s language so BugBeat checks it strictly as that language, or leave it on Auto-detect.' },
    { target: '#demo-select', title: 'No code yet? Try a demo',
      text: 'Load a sample with clean code, minor warnings, logic errors, critical issues, or a mix of everything.' },
    { target: '#analyze-btn', title: 'Analyze',
      text: 'Checks your code for errors and turns the results into a rhythm you can see and hear. Each analysis is saved to your History.' },
    { target: '#run-btn', title: 'Run your code',
      text: 'Runs the code and shows its output in a panel below. Pick a language first, since Auto-detect and TypeScript can\'t be run.' },
    { target: '#clear-btn', title: 'Clear',
      text: 'Empties the editor and removes the highlights so you can start over.' },

    // ── Results ──
    { target: '.cb-panel--issues', title: 'Issues and how to fix them',
      text: 'Each issue shows its line, how serious it is, what\'s wrong and how to fix it. Press Copy to copy the corrected line.' },
    { target: '.cb-panel--sequencer', title: 'The rhythm of your code',
      text: 'Every line of code becomes a bar: green is clean, then yellow, orange and red for warnings, errors and critical issues. Point at a bar to see its line.' },
    { target: '.cb-panel--playback', title: 'Listen',
      text: 'Press play to hear your code. Problems add more and more distortion to the music. Change the speed with BPM, and see how many issues of each kind were found.' },

    // ── Music ──
    { target: '#style-select', title: 'Choose the music',
      text: 'Pick the style of the generated music: Lo-fi, Jazz, Rock, Electronic or Ambient.' },
    { target: '.cb-audio-upload', title: 'Use your own song',
      text: 'Upload an MP3 or WAV to hear your code through your own music. Press ✕ beside it to go back to the generated music.' },

    // ── Layout ──
    { target: '.cb-gutter--both', bodyClass: 'cb-tour-show-gutters', title: 'Resize the panels',
      text: 'Drag the borders between the panels, or this point where they meet, to make any panel bigger. Double-click a border to go back to the default layout.' },
    { target: '#notif-btn', title: 'Notifications',
      text: 'Finished analyses and announcements from the BugBeat team show up here.' },

    // ── Sidebar ──
    { target: '#menu-btn', title: 'Your sidebar',
      text: 'This button shows or hides the sidebar with your settings and account. Let\'s look inside.' },
    { target: '#appearance-section', sidebar: true, title: 'Appearance',
      text: 'Pick a theme (Dark, Light, Midnight, Violet, Ember, Paper or High contrast), and make the text or the code bigger or smaller. ↺ Reset puts it all back to default.' },
    { target: '#history-btn', sidebar: true, title: 'History',
      text: 'See your past analyses with their issues and code, search and filter them, and restore one back into the editor.' },
    { target: '#change-pw-btn', sidebar: true, title: 'Your account',
      text: 'Change your password here, or set one if you signed in with Google.' },
    { target: '#admin-link', sidebar: true, title: 'Admin',
      text: 'Manage users, bug reports, invites and announcements.' },
    { target: '#tour-btn', sidebar: true, title: 'Replay this tour',
      text: 'Come back here any time to take this tour again.' },

    // ── Help ──
    { target: '#bugreport-fab', sidebar: true, title: 'Found a problem in BugBeat?',
      text: 'Report a bug here and the team will look into it.' },
    { title: 'You\'re all set!',
      text: 'Try it now: load a demo, press Analyze, then press play to hear your code.' }
  ];

  const user = (() => {
    try { return JSON.parse(localStorage.getItem('cb_user') || 'null'); } catch (e) { return null; }
  })();
  if (!user) return;                                  // app.js sends them to login
  // "v2": the tour was rewritten, so everyone sees the new one once.
  const DONE_KEY = 'cb-tour-done-v2:' + (user.username || user.id || 'user');

  let root, spot, card, titleEl, textEl, countEl, backBtn, nextBtn;
  let index = 0;
  let sidebarWasOpen = false;
  let steps = [];
  let lastFocus = null;

  function isShown(el) {
    if (!el || el.closest('[hidden]')) return false;
    return el.getClientRects().length > 0;
  }

  function build() {
    root = document.createElement('div');
    root.className = 'cb-tour';
    root.innerHTML = `
      <div class="cb-tour__blocker"></div>
      <div class="cb-tour__spot" aria-hidden="true"></div>
      <div class="cb-tour__card" role="dialog" aria-modal="true" aria-labelledby="cb-tour-title" aria-describedby="cb-tour-text">
        <div class="cb-tour__count" id="cb-tour-count"></div>
        <h2 class="cb-tour__title" id="cb-tour-title"></h2>
        <p class="cb-tour__text" id="cb-tour-text"></p>
        <div class="cb-tour__actions">
          <button type="button" class="cb-tour__skip">Skip tour</button>
          <span class="cb-tour__spacer"></span>
          <button type="button" class="cb-btn cb-btn--ghost cb-tour__back">Back</button>
          <button type="button" class="cb-btn cb-btn--primary cb-tour__next">Next</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    spot    = root.querySelector('.cb-tour__spot');
    card    = root.querySelector('.cb-tour__card');
    titleEl = root.querySelector('.cb-tour__title');
    textEl  = root.querySelector('.cb-tour__text');
    countEl = root.querySelector('.cb-tour__count');
    backBtn = root.querySelector('.cb-tour__back');
    nextBtn = root.querySelector('.cb-tour__next');

    root.querySelector('.cb-tour__skip').addEventListener('click', () => end());
    backBtn.addEventListener('click', () => go(index - 1));
    nextBtn.addEventListener('click', () => go(index + 1));
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
    else if (e.key === 'Tab') {
      // Keep keyboard focus inside the card.
      const items = [...card.querySelectorAll('button:not([hidden])')];
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function place() {
    const step = steps[index];
    const el = step && step.target ? document.querySelector(step.target) : null;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 12, margin = 12;

    if (!el) {
      spot.hidden = true;
      root.classList.add('cb-tour--center');
      card.style.left = '';
      card.style.top = '';
      return;
    }
    root.classList.remove('cb-tour--center');
    spot.hidden = false;

    const r = el.getBoundingClientRect();
    const pad = 6;
    // Big panels are clipped to the screen so the outline stays visible.
    const top    = Math.max(r.top - pad, 4);
    const left   = Math.max(r.left - pad, 4);
    const bottom = Math.min(r.bottom + pad, vh - 4);
    const right  = Math.min(r.right + pad, vw - 4);
    spot.style.top    = top + 'px';
    spot.style.left   = left + 'px';
    spot.style.width  = (right - left) + 'px';
    spot.style.height = (bottom - top) + 'px';

    // Card: below the element if it fits, else above, else inside the
    // element's lower part (for panels taller than the screen).
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let y;
    if (bottom + gap + ch <= vh - margin) y = bottom + gap;
    else if (top - gap - ch >= margin) y = top - gap - ch;
    else y = Math.max(margin, Math.min(bottom - ch - gap, vh - ch - margin));
    let x = r.left + r.width / 2 - cw / 2;
    x = Math.max(margin, Math.min(x, vw - cw - margin));
    card.style.left = x + 'px';
    card.style.top  = y + 'px';
  }

  function go(i) {
    if (i < 0) return;
    if (i >= steps.length) { end(); return; }
    index = i;
    const step = steps[index];
    if (window.cbSidebar) window.cbSidebar.setOpen(step.sidebar ? true : sidebarWasOpen);
    // Some steps light up extra parts of the page (e.g. the resize lines).
    document.body.classList.remove('cb-tour-show-gutters');
    if (step.bodyClass) document.body.classList.add(step.bodyClass);
    const el = step.target ? document.querySelector(step.target) : null;
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    countEl.textContent = `${index + 1} of ${steps.length}`;
    titleEl.textContent = step.title;
    textEl.textContent  = step.text;
    backBtn.hidden = index === 0;
    nextBtn.textContent = index === steps.length - 1 ? 'Finish' : (index === 0 ? 'Start tour' : 'Next');

    // Restart the card's fade-in for each step.
    card.classList.remove('cb-tour__card--in');
    void card.offsetWidth;
    card.classList.add('cb-tour__card--in');

    place();
    // Opening/closing the sidebar moves things; measure again once it has.
    requestAnimationFrame(() => requestAnimationFrame(place));
    setTimeout(place, 250);
    nextBtn.focus();
  }

  function start() {
    if (root && !root.hidden) return;
    // Close any open notification list etc. so it doesn't sit on top.
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    steps = STEPS.filter(s => {
      if (!s.target) return true;
      const el = document.querySelector(s.target);
      // Sidebar items are hidden until the sidebar opens, so only check
      // the item itself (e.g. Admin stays hidden for normal users).
      if (s.sidebar) return !!el && !el.hidden && !!window.cbSidebar;
      return isShown(el);
    });
    sidebarWasOpen = window.cbSidebar ? window.cbSidebar.isOpen() : false;
    if (!root) build();
    lastFocus = document.activeElement;
    root.hidden = false;
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    go(0);
  }

  function end() {
    if (!root || root.hidden) return;
    root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.body.classList.remove('cb-tour-show-gutters');
    if (window.cbSidebar) window.cbSidebar.setOpen(sidebarWasOpen);
    try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // "Take the tour" in the sidebar replays it.
  const replay = document.getElementById('tour-btn');
  if (replay) replay.addEventListener('click', () => setTimeout(start, 50));

  // First visit: start once the page (and the editor) has loaded.
  let done = false;
  try { done = localStorage.getItem(DONE_KEY) === '1'; } catch (e) {}
  if (!done) {
    const begin = () => setTimeout(start, 700);
    if (document.readyState === 'complete') begin();
    else window.addEventListener('load', begin, { once: true });
  }

  window.startBugBeatTour = start;
})();
