// ═══════════════════════════════════════════════
//  menu.js — the ☰ menu in the main header (index.html)
//  Opens/closes the menu panel. The controls inside it (demo loader,
//  Clear, audio upload, History, theme toggle, Admin, Logout) keep their
//  own ids and behaviour from app.js / history.js / theme.js; this file
//  only shows and hides the panel.
// ═══════════════════════════════════════════════
(function () {
  const wrap  = document.getElementById('menu-wrap');
  const btn   = document.getElementById('menu-btn');
  const panel = document.getElementById('menu-panel');
  if (!wrap || !btn || !panel) return;

  function isOpen() {
    return !panel.hidden;
  }

  function open() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    if (window.keepInView) keepInView(panel);   // see popover.js
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn.focus();
  }

  btn.addEventListener('click', () => {
    if (isOpen()) close(false); else open();
  });

  // Click anywhere outside the menu closes it.
  document.addEventListener('click', (e) => {
    if (isOpen() && !wrap.contains(e.target)) close(false);
  });

  // Esc closes it and puts focus back on the ☰ button.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close(true);
  });

  // Items marked data-menu-close close the menu after they're used:
  // buttons when clicked, the demo <select> once a demo is picked.
  // (Upload audio and the theme toggle leave it open.)
  panel.addEventListener('click', (e) => {
    const item = e.target.closest('button[data-menu-close]');
    if (item) close(false);
  });
  panel.addEventListener('change', (e) => {
    // (app.js resets the demo select back to "Load demo…" in its own change
    // handler, which runs first, so don't check the selected value here.)
    if (e.target.matches('select[data-menu-close]')) close(false);
  });
})();
