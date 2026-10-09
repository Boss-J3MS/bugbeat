// ═══════════════════════════════════════════════
//  menu.js — the settings sidebar on the left of the main page (index.html)
//  The ☰ button in the header shows/hides it. The controls inside it
//  (music style, audio upload, My tracks, History, Change password,
//  theme toggle, Admin, Logout) keep their own ids and behaviour from
//  app.js / tracks.js / history.js / theme.js / account.js / logout.js;
//  this file only shows and hides the panel.
//
//  Wide screens: the sidebar is docked — it sits beside the workspace and
//  pushes it over. It stays open until ☰ is clicked again, and the choice
//  is remembered for next time.
//  Narrow screens (≤ 768px): it slides over the workspace with a dark
//  backdrop, and closes on a backdrop click, Esc, or after an item is used.
// ═══════════════════════════════════════════════
(function () {
  const btn      = document.getElementById('menu-btn');
  const panel    = document.getElementById('menu-panel');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!btn || !panel) return;

  const KEY    = 'cb-sidebar';
  const narrow = window.matchMedia('(max-width: 768px)');

  function savedOpen() {
    try { return localStorage.getItem(KEY) !== 'closed'; } catch (e) { return true; }
  }
  function save(open) {
    try { localStorage.setItem(KEY, open ? 'open' : 'closed'); } catch (e) {}
  }

  function isOpen() {
    return !panel.hidden;
  }

  function setOpen(open, opts) {
    opts = opts || {};
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const label = open ? 'Hide sidebar' : 'Show sidebar';
    btn.setAttribute('data-tip', label);      // tooltip (style.css)
    btn.setAttribute('aria-label', label);
    document.body.classList.toggle('cb-sidebar-open', open);
    if (backdrop) backdrop.hidden = !(open && narrow.matches);
    if (!narrow.matches && opts.remember) save(open);
    if (!open && opts.returnFocus) btn.focus();
  }

  // Starting state: docked open on wide screens (unless it was closed
  // last time), closed on phones so it doesn't cover the editor.
  function applyDefault() {
    setOpen(narrow.matches ? false : savedOpen());
  }
  applyDefault();
  narrow.addEventListener('change', applyDefault);

  btn.addEventListener('click', () => {
    setOpen(!isOpen(), { remember: true });
  });

  if (backdrop) backdrop.addEventListener('click', () => setOpen(false));

  // Esc closes the overlay on narrow screens (the docked sidebar stays put).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && narrow.matches) setOpen(false, { returnFocus: true });
  });

  // Items marked data-menu-close close the overlay after they're used on
  // narrow screens. When docked, the sidebar stays open.
  panel.addEventListener('click', (e) => {
    if (narrow.matches && e.target.closest('button[data-menu-close]')) setOpen(false);
  });

  // The BugBeat logo works as a Home button: it reloads the page for a
  // fresh start (empty editor, no results). Code in the editor isn't saved
  // anywhere, so if there is any, ask first instead of losing it.
  const brand = document.getElementById('brand-link');
  if (brand) {
    brand.addEventListener('click', (e) => {
      e.preventDefault();
      const goHome = () => window.location.reload();
      const hasCode = typeof getCode === 'function' && getCode().trim() !== '';
      if (hasCode && typeof showNotice === 'function') {
        showNotice({
          title: 'Start fresh?',
          message: 'This clears the code in the editor and its results. Your past analyses stay in History.',
          actionLabel: 'Start fresh',
          onAction: goHome,
          cancelLabel: 'Cancel'
        });
      } else {
        goHome();
      }
    });
  }
})();
