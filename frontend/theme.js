// ═══════════════════════════════════════════════
//  theme.js — light/dark mode toggle
//  Shared across index.html, login.html, signup.html, admin.html.
//  The actual theme is applied as early as possible by a small inline
//  script in each page's <head> (before first paint, to avoid a flash
//  of the wrong theme). This file just wires up the toggle button and
//  keeps localStorage in sync once the DOM is ready.
// ═══════════════════════════════════════════════
(function () {
  const STORAGE_KEY = 'cb-theme';

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
    updateToggleButton();
    // On pages with the Monaco code editor (index.html), app.js exposes
    // this hook once Monaco finishes loading, so the editor's own theme
    // switches along with the rest of the page.
    if (typeof window.setMonacoTheme === 'function') {
      window.setMonacoTheme(theme);
    }
  }

  function toggleTheme() {
    setTheme(getTheme() === 'light' ? 'dark' : 'light');
  }

  function updateToggleButton() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const isLight = getTheme() === 'light';
    btn.textContent = isLight ? '☀️' : '🌙';
    btn.setAttribute('aria-pressed', String(isLight));
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateToggleButton();
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', toggleTheme);
  });
})();
