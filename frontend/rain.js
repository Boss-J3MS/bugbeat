/* ═══════════════════════════════════════════════
   CODEBEAT — rain.js
   A "1010110" code-rain filling the auth pages'
   dedicated visual panel — a nod to the IDE/terminal look.
═══════════════════════════════════════════════ */
(function () {
  var canvas = document.getElementById('auth-rain');
  if (!canvas || !canvas.getContext) return;

  var panel = canvas.parentElement; // .auth-visual
  if (!panel) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var highContrast = window.matchMedia && (
    window.matchMedia('(prefers-contrast: more)').matches ||
    window.matchMedia('(forced-colors: active)').matches
  );
  // Same call as the pulsing logo makes: a person who has asked their OS
  // for more contrast, or is running Windows High Contrast Mode, doesn't
  // want a moving field of characters behind their form either.
  if (highContrast) { canvas.style.display = 'none'; return; }

  var ctx = canvas.getContext('2d');
  var FONT_SIZE = 20;
  var FRAME_MS = 80; // ~12fps — a rain effect doesn't need 60fps, and this keeps it cheap
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  var cols = 0;
  var drops = [];
  var panelW = 0, panelH = 0;

  function bgHex() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? '#f4f5f7' : '#0d0f12';
  }

  // The rain now fills its own dedicated panel — the .auth-card lives in
  // the *other* panel entirely, so there's no text region to dodge here
  // and colors can stay lively without any per-pixel contrast risk.
  function themeColors() {
    if (document.documentElement.getAttribute('data-theme') === 'light') {
      return { fade: 'rgba(244,245,247,0.15)', head: 'rgba(14,164,114,0.6)', tail: 'rgba(51,65,85,0.32)' };
    }
    return { fade: 'rgba(13,15,18,0.13)', head: 'rgba(29,228,168,0.85)', tail: 'rgba(29,228,168,0.4)' };
  }

  // Sized to the .auth-visual panel, not the viewport — on the split
  // layout the panel is ~50% of the window width and full height, and it
  // disappears below the 860px breakpoint, at which point this just does
  // nothing until it reappears.
  function resize() {
    var w = panel.clientWidth, h = panel.clientHeight;
    if (w === 0 || h === 0) return; // panel hidden (narrow viewport) — nothing to draw
    panelW = w; panelH = h;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var newCols = Math.ceil(w / FONT_SIZE);
    var newDrops = [];
    for (var i = 0; i < newCols; i++) {
      newDrops[i] = drops[i] !== undefined ? drops[i] : Math.random() * -60;
    }
    cols = newCols;
    drops = newDrops;
    ctx.fillStyle = bgHex();
    ctx.fillRect(0, 0, w, h);
  }

  // ResizeObserver tracks the panel itself, which covers window resizes,
  // the 860px breakpoint hiding/showing the panel, and any layout shift —
  // a plain window 'resize' listener would miss the breakpoint case.
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });
    ro.observe(panel);
  } else {
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });
  }
  var resizeTimer;

  var last = 0;
  var running = false;
  var rafId = null;

  function frame(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    if (ts - last < FRAME_MS) return;
    last = ts;

    if (panelW === 0 || panelH === 0) return; // panel currently hidden

    var c = themeColors();

    ctx.fillStyle = c.fade;
    ctx.fillRect(0, 0, panelW, panelH);

    ctx.font = FONT_SIZE + 'px "SFMono-Regular", "Courier New", monospace';
    ctx.textBaseline = 'top';

    for (var i = 0; i < cols; i++) {
      var x = i * FONT_SIZE;
      var y = drops[i] * FONT_SIZE;

      ctx.fillStyle = Math.random() < 0.09 ? c.head : c.tail;
      ctx.fillText(Math.random() < 0.5 ? '0' : '1', x, y);

      if (y > panelH && Math.random() > 0.975) {
        drops[i] = 0;
      } else {
        drops[i] += 1;
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    last = 0;
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }

  // Draws one static, sparse field for prefers-reduced-motion — pulled
  // out into its own function so a theme switch (see below) can redraw
  // it too, not just the very first paint.
  function drawStaticField() {
    if (panelW === 0 || panelH === 0) return;
    var c = themeColors();
    ctx.fillStyle = bgHex();
    ctx.fillRect(0, 0, panelW, panelH);
    ctx.font = FONT_SIZE + 'px "SFMono-Regular", "Courier New", monospace';
    ctx.textBaseline = 'top';
    for (var i = 0; i < cols; i++) {
      if (Math.random() < 0.5) continue;
      var x = i * FONT_SIZE;
      var y = Math.random() * panelH;
      ctx.fillStyle = c.tail;
      ctx.fillText(Math.random() < 0.5 ? '0' : '1', x, y);
    }
  }

  resize();

  if (reduceMotion) {
    // One quiet, static field instead of a loop — motion is what
    // prefers-reduced-motion asks to avoid, not the decoration itself.
    drawStaticField();
  } else {
    start();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
  }

  // The running animation only picks up a theme switch gradually — each
  // frame's low-alpha fade blends toward the new color over ~15-20
  // frames (~1-1.5s at 12fps), by design, so trailing characters fade
  // out smoothly instead of snapping away. That's fine for the rain
  // itself, but it means the *panel background* visibly lags behind
  // every other themed surface on the page (the card, the toggle, etc.),
  // which all flip instantly. Watching data-theme directly and hard-
  // repainting the moment it changes closes that gap — the panel now
  // recolors in step with the rest of the page, and the rain just
  // resumes from that fresh, correctly-themed base.
  if (window.MutationObserver) {
    var themeObserver = new MutationObserver(function () {
      if (reduceMotion) drawStaticField();
      else if (panelW > 0 && panelH > 0) {
        ctx.fillStyle = bgHex();
        ctx.fillRect(0, 0, panelW, panelH);
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  }
})();
