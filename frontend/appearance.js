// ═══════════════════════════════════════════════
//  appearance.js — Appearance settings in the sidebar (index.html)
//    • Theme: a colour theme for the whole app and the code editor.
//    • Text size: makes all of BugBeat's text bigger or smaller.
//    • Code size: font size of the code editor only.
//  Choices are remembered in this browser. They are applied before the
//  page is drawn by the small script in index.html's <head>, so the page
//  never flashes the wrong theme or size.
//
//  How themes work: every theme is built on light or dark mode
//  (data-theme on <html>, which the rest of the app already understands)
//  plus its own colours (data-palette on <html>, defined in style.css).
// ═══════════════════════════════════════════════
(function () {
  const THEMES = {
    dark:     { label: '🌙 Dark (default)', mode: 'dark'  },
    light:    { label: '☀️ Light',          mode: 'light' },
    midnight: { label: '🌌 Midnight',       mode: 'dark'  },
    violet:   { label: '🔮 Violet',         mode: 'dark'  },
    ember:    { label: '🔥 Ember',          mode: 'dark'  },
    paper:    { label: '📜 Paper',          mode: 'light' },
    contrast: { label: '⬛ High contrast',  mode: 'dark'  }
  };
  const TEXT_SIZES = [87.5, 93.75, 100, 112.5, 125, 137.5];   // % of normal
  const CODE_MIN = 10, CODE_MAX = 24, CODE_DEFAULT = 13;

  const KEYS = { theme: 'cb-palette', mode: 'cb-theme', text: 'cb-text-size', code: 'cb-code-size' };
  const root = document.documentElement;

  const read  = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  // ── Theme ──────────────────────────────────────
  function currentTheme() {
    const saved = read(KEYS.theme);
    if (saved && THEMES[saved]) return saved;
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(name) {
    const theme = THEMES[name] || THEMES.dark;
    root.setAttribute('data-theme', theme.mode);
    if (name === 'dark' || name === 'light') root.removeAttribute('data-palette');
    else root.setAttribute('data-palette', name);
    write(KEYS.theme, name);
    write(KEYS.mode, theme.mode);           // other pages (login, admin) use this
    // app.js rebuilds the editor's colours from the new theme.
    if (typeof window.setMonacoTheme === 'function') window.setMonacoTheme(theme.mode);
  }

  // ── Text size ──────────────────────────────────
  function currentTextSize() {
    const v = parseFloat(read(KEYS.text));
    return TEXT_SIZES.includes(v) ? v : 100;
  }
  function applyTextSize(pct) {
    root.style.fontSize = pct === 100 ? '' : pct + '%';
    write(KEYS.text, String(pct));
    // Panels and the resize handles re-measure themselves.
    window.dispatchEvent(new Event('resize'));
  }

  // ── Code size ──────────────────────────────────
  function currentCodeSize() {
    const v = parseInt(read(KEYS.code), 10);
    return v >= CODE_MIN && v <= CODE_MAX ? v : CODE_DEFAULT;
  }
  function applyCodeSize(px) {
    write(KEYS.code, String(px));
    if (typeof monacoEditor !== 'undefined' && monacoEditor) monacoEditor.updateOptions({ fontSize: px });
  }

  // ── Sidebar controls ───────────────────────────
  const themeSelect = document.getElementById('theme-select');
  const textDown = document.getElementById('text-size-down');
  const textUp   = document.getElementById('text-size-up');
  const textVal  = document.getElementById('text-size-value');
  const codeDown = document.getElementById('code-size-down');
  const codeUp   = document.getElementById('code-size-up');
  const codeVal  = document.getElementById('code-size-value');
  const resetBtn = document.getElementById('appearance-reset');

  if (themeSelect) {
    themeSelect.innerHTML = Object.entries(THEMES)
      .map(([key, t]) => `<option value="${key}">${t.label}</option>`).join('');
    themeSelect.value = currentTheme();
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
  }

  function showText() {
    const pct = currentTextSize();
    if (textVal) textVal.textContent = `${pct}%`;
    const i = TEXT_SIZES.indexOf(pct);
    if (textDown) textDown.disabled = i <= 0;
    if (textUp)   textUp.disabled   = i >= TEXT_SIZES.length - 1;
  }
  function stepText(dir) {
    const i = TEXT_SIZES.indexOf(currentTextSize());
    const next = TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, i + dir))];
    applyTextSize(next);
    showText();
  }

  function showCode() {
    const px = currentCodeSize();
    if (codeVal) codeVal.textContent = `${px}px`;
    if (codeDown) codeDown.disabled = px <= CODE_MIN;
    if (codeUp)   codeUp.disabled   = px >= CODE_MAX;
  }
  function stepCode(dir) {
    applyCodeSize(Math.min(CODE_MAX, Math.max(CODE_MIN, currentCodeSize() + dir)));
    showCode();
  }

  textDown?.addEventListener('click', () => stepText(-1));
  textUp?.addEventListener('click',   () => stepText(1));
  codeDown?.addEventListener('click', () => stepCode(-1));
  codeUp?.addEventListener('click',   () => stepCode(1));
  resetBtn?.addEventListener('click', () => {
    applyTheme('dark');
    if (themeSelect) themeSelect.value = 'dark';
    applyTextSize(100);
    applyCodeSize(CODE_DEFAULT);
    showText();
    showCode();
  });

  showText();
  showCode();
})();
