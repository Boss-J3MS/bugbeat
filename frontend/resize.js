// ═══════════════════════════════════════════════
//  resize.js — drag to resize the panels (index.html)
//  Adds three handles on top of the workspace grid:
//    • a vertical bar between the left and right panels,
//    • a horizontal bar between Code and Rhythm (left column),
//    • a small square where they cross, which moves both at once.
//  Code and Rhythm can be resized freely along the whole left column.
//  Playback (bottom right) always keeps its own fixed height; Issues
//  fills the space above it.
//  Double-click a handle to go back to the default sizes. The handles can also
//  be focused with Tab and moved with the arrow keys. Sizes are remembered
//  in this browser. On narrow screens (panels stacked) the handles hide.
// ═══════════════════════════════════════════════
(function () {
  const ws     = document.querySelector('.cb-workspace');
  const topL   = document.querySelector('.cb-panel--editor');    // Code (top left)
  const botR   = document.querySelector('.cb-panel--playback');  // Playback (bottom right, fixed height)
  if (!ws || !topL || !botR) return;

  const KEY     = 'cb-panel-split-v2';
  const OLD_KEY = 'cb-panel-split';   // older layout (width is carried over)
  const MIN_X   = 0.2, MAX_X = 0.8;   // left/right: each side at least 20% wide
  const MIN_CODE   = 100;             // px: smallest Code panel
  const MIN_RHYTHM = 90;              // px: smallest Rhythm panel (header + a row of beats)
  const STEP    = 0.02;               // arrow-key step
  const DEFAULT_X = 0.7;
  const DEFAULT_CODE_SHARE = 0.62;    // default: Code takes 62% of the space above Playback
  const narrow  = window.matchMedia('(max-width: 768px)');

  // split.x = width of the left column (0–1).
  // split.y = where the Code/Rhythm border is, as a share of the full
  //           height of the panels (0–1), or null for the default.
  let split = { x: DEFAULT_X, y: null };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && isFinite(saved.x)) {
      split = { x: saved.x, y: isFinite(saved.y) ? saved.y : null };
    } else {
      const old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null');
      if (old && isFinite(old.x)) split.x = old.x;
    }
  } catch (e) {}

  const clampX = (v) => Math.min(MAX_X, Math.max(MIN_X, v));

  function makeHandle(kind, label) {
    const h = document.createElement('div');
    h.className = `cb-gutter cb-gutter--${kind}`;
    h.tabIndex = 0;
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-label', label);
    if (kind !== 'both') h.setAttribute('aria-orientation', kind === 'x' ? 'vertical' : 'horizontal');
    h.title = 'Drag to resize · double-click to reset';
    ws.appendChild(h);
    return h;
  }
  // (The crossing handle is added first so that hovering it can light up
  // the two line handles that follow it — see style.css.)
  const gb = makeHandle('both', 'Resize all panels');
  const gx = makeHandle('x', 'Resize left and right panels');
  const gy = makeHandle('y', 'Resize Code and Rhythm panels');

  // The height Playback needs for its contents (its children don't stretch).
  function playbackHeight() {
    let h = botR.offsetHeight - botR.clientHeight;   // its borders
    for (const c of botR.children) {
      if (c.hidden) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.position === 'absolute') continue;
      h += c.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    }
    return Math.ceil(h);
  }

  // Full height of the panel area: from the top of Code to the bottom of
  // Playback (the Run output panel, when shown, sits below and isn't part of it).
  function totalHeight() {
    return botR.getBoundingClientRect().bottom - topL.getBoundingClientRect().top;
  }

  let lastRows = '', lastLow = null;

  function apply() {
    split.x = clampX(split.x);
    ws.style.setProperty('--split-cols', `minmax(0, ${split.x}fr) minmax(0, ${1 - split.x}fr)`);
    gx.setAttribute('aria-valuenow', Math.round(split.x * 100));

    if (narrow.matches) { place(); return; }

    const T  = totalHeight();
    const hp = playbackHeight();
    const above = Math.max(0, T - hp);          // space above Playback (= Issues height)

    // Where the Code/Rhythm border goes, in px from the top.
    let codeH = split.y == null ? above * DEFAULT_CODE_SHARE : split.y * T;
    codeH = Math.round(Math.min(Math.max(codeH, MIN_CODE), Math.max(MIN_CODE, T - MIN_RHYTHM)));
    if (split.y != null && T > 0) split.y = codeH / T;

    let rows, low;
    if (codeH <= above) {
      // Border is above the top of Playback:
      //   row 1 = Code | Issues, row 2 = Rhythm | Issues, row 3 = Rhythm | Playback
      low  = false;
      rows = `minmax(0, ${codeH}fr) minmax(0, ${Math.max(0, above - codeH)}fr) auto`;
    } else {
      // Border is lower than the top of Playback (Rhythm is shorter than Playback):
      //   row 1 = Code | Issues, row 2 = Code | Playback, row 3 = Rhythm | Playback
      low  = true;
      const inPlayback = codeH - above;
      rows = `minmax(0, 1fr) ${inPlayback}px ${Math.max(0, hp - inPlayback)}px`;
    }
    if (rows !== lastRows) { ws.style.setProperty('--split-rows', rows); lastRows = rows; }
    if (low !== lastLow)   { ws.classList.toggle('cb-split--low', low); lastLow = low; }

    gy.setAttribute('aria-valuenow', T > 0 ? Math.round((codeH / T) * 100) : 50);
    place();
  }

  // Put the handles on the panel borders.
  function place() {
    if (narrow.matches) return;
    const w = ws.getBoundingClientRect();
    const a = topL.getBoundingClientRect();
    const b = botR.getBoundingClientRect();
    const top = a.top - w.top, height = b.bottom - a.top;
    const xLine = a.right - w.left, yLine = a.bottom - w.top;
    gx.style.left = xLine + 'px'; gx.style.top = top + 'px'; gx.style.height = height + 'px';
    // The Code/Rhythm border is only in the left column.
    gy.style.top  = yLine + 'px'; gy.style.left = '0px';    gy.style.width = (a.right - w.left) + 'px';
    gb.style.left = xLine + 'px'; gb.style.top  = yLine + 'px';
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(split)); } catch (e) {}
  }

  function startDrag(e, axes) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('cb-resizing', axes === 'both' ? 'cb-resizing--both' : `cb-resizing--${axes}`);

    const move = (ev) => {
      const w = ws.getBoundingClientRect();
      const a = topL.getBoundingClientRect();
      if (axes !== 'y') split.x = (ev.clientX - w.left) / w.width;
      if (axes !== 'x') {
        const T = totalHeight();
        if (T > 0) split.y = (ev.clientY - a.top) / T;
      }
      apply();
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      document.body.classList.remove('cb-resizing', 'cb-resizing--x', 'cb-resizing--y', 'cb-resizing--both');
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function reset(axes) {
    if (axes !== 'y') split.x = DEFAULT_X;
    if (axes !== 'x') split.y = null;
    apply();
    save();
  }

  // Current Code/Rhythm border as a share of the height (for arrow keys).
  function currentY() {
    const T = totalHeight();
    return T > 0 ? topL.getBoundingClientRect().height / T : 0.5;
  }

  function onKey(e, axes) {
    const d = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[e.key];
    if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); reset(axes); return; }
    if (!d) return;
    if (axes !== 'y') split.x += d[0];
    if (axes !== 'x' && d[1]) split.y = currentY() + d[1];
    e.preventDefault();
    apply();
    save();
  }

  [[gx, 'x'], [gy, 'y'], [gb, 'both']].forEach(([h, axes]) => {
    h.addEventListener('pointerdown', (e) => startDrag(e, axes));
    h.addEventListener('dblclick', () => reset(axes));
    h.addEventListener('keydown', (e) => onKey(e, axes));
  });

  // Re-fit whenever anything changes size (window, sidebar opening/closing,
  // the output panel appearing, Playback's contents changing, text size, …).
  let queued = false;
  function refit() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; apply(); });
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(refit);
    ro.observe(ws); ro.observe(topL); ro.observe(botR);
    for (const c of botR.children) ro.observe(c);
  }
  window.addEventListener('resize', refit);
  narrow.addEventListener('change', refit);

  apply();
})();
