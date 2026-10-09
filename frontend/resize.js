// ═══════════════════════════════════════════════
//  resize.js — drag to resize the 2x2 panels (index.html)
//  Adds three handles on top of the workspace grid:
//    • a vertical bar between the left and right panels,
//    • a horizontal bar between the top and bottom panels,
//    • a small square where they cross, which moves both at once.
//  Double-click a handle to go back to the default sizes. The handles can also
//  be focused with Tab and moved with the arrow keys. Sizes are remembered
//  in this browser. On narrow screens (panels stacked) the handles hide.
// ═══════════════════════════════════════════════
(function () {
  const ws     = document.querySelector('.cb-workspace');
  const topL   = document.querySelector('.cb-panel--editor');    // top-left panel
  const botR   = document.querySelector('.cb-panel--playback');  // bottom-right panel
  if (!ws || !topL || !botR) return;

  const KEY    = 'cb-panel-split';
  const MIN    = 0.2;      // a panel can't get smaller than 20% of the space
  const MAX    = 0.8;
  const STEP   = 0.02;     // arrow-key step
  const narrow = window.matchMedia('(max-width: 768px)');

  // Default layout: a wide editor column on the left and taller top
  // panels (Code / Issues), with Rhythm / Playback below.
  const DEFAULT = { x: 0.7, y: 0.62 };
  let split = { ...DEFAULT };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && isFinite(saved.x) && isFinite(saved.y)) split = saved;
  } catch (e) {}

  const clamp = (v) => Math.min(MAX, Math.max(MIN, v));

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
  const gb = makeHandle('both', 'Resize all four panels');
  const gx = makeHandle('x', 'Resize left and right panels');
  const gy = makeHandle('y', 'Resize top and bottom panels');

  function apply() {
    split.x = clamp(split.x);
    split.y = clamp(split.y);
    ws.style.setProperty('--split-cols', `minmax(0, ${split.x}fr) minmax(0, ${1 - split.x}fr)`);
    ws.style.setProperty('--split-rows', `minmax(0, ${split.y}fr) minmax(0, ${1 - split.y}fr)`);
    gx.setAttribute('aria-valuenow', Math.round(split.x * 100));
    gy.setAttribute('aria-valuenow', Math.round(split.y * 100));
    place();
  }

  // Put the handles on the panel borders. The 2x2 area runs from the top
  // of the top-left panel to the bottom of the bottom-right one (the Run
  // output panel, when shown, sits below it and isn't part of the split).
  function place() {
    if (narrow.matches) return;
    const w  = ws.getBoundingClientRect();
    const a  = topL.getBoundingClientRect();
    const b  = botR.getBoundingClientRect();
    const top = a.top - w.top, height = b.bottom - a.top;
    const xLine = a.right - w.left, yLine = a.bottom - w.top;
    gx.style.left = xLine + 'px'; gx.style.top = top + 'px'; gx.style.height = height + 'px';
    gy.style.top  = yLine + 'px'; gy.style.left = '0px';    gy.style.width = w.width + 'px';
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
      const b = botR.getBoundingClientRect();
      if (axes !== 'y') split.x = (ev.clientX - w.left) / w.width;
      if (axes !== 'x') split.y = (ev.clientY - a.top) / (b.bottom - a.top);
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
    if (axes !== 'y') split.x = DEFAULT.x;
    if (axes !== 'x') split.y = DEFAULT.y;
    apply();
    save();
  }

  function onKey(e, axes) {
    const d = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[e.key];
    if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); reset(axes); return; }
    if (!d) return;
    if (axes !== 'y') split.x += d[0];
    if (axes !== 'x') split.y += d[1];
    e.preventDefault();
    apply();
    save();
  }

  [[gx, 'x'], [gy, 'y'], [gb, 'both']].forEach(([h, axes]) => {
    h.addEventListener('pointerdown', (e) => startDrag(e, axes));
    h.addEventListener('dblclick', () => reset(axes));
    h.addEventListener('keydown', (e) => onKey(e, axes));
  });

  // Keep the handles on the borders whenever anything changes size
  // (window, sidebar opening/closing, the output panel appearing, …).
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(place);
    ro.observe(ws); ro.observe(topL); ro.observe(botR);
  }
  window.addEventListener('resize', place);
  narrow.addEventListener('change', place);

  apply();
})();
