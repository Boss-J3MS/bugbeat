// ═══════════════════════════════════════════════
//  toast.js — small pop-up messages in the corner ("toasts")
//  toast(message, type, options) tells the user that an action finished:
//  the analysis is done, a track was deleted, a setting was saved, etc.
//    type     'success' (default), 'error', 'warning' or 'info'
//    options  key:      a newer toast with the same key replaces the older
//                       one (e.g. moving the tempo slider several times)
//             silent:   not read out by screen readers, for actions that
//                       already announce their own result
//             duration: milliseconds before it hides (errors stay longer)
//  A toast stays while the pointer is on it, and has a ✕ to close it.
// ═══════════════════════════════════════════════
(function () {
  const ICONS = { success: '✓', error: '!', warning: '!', info: 'i' };
  const MAX_SHOWN = 4;
  let box = null;

  function container() {
    if (box && document.body.contains(box)) return box;
    box = document.createElement('div');
    box.className = 'cb-toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
    return box;
  }

  function hide(el) {
    if (!el || el.dataset.leaving) return;
    el.dataset.leaving = '1';
    clearTimeout(el._timer);
    el.classList.add('cb-toast--out');
    setTimeout(() => el.remove(), 200);
  }

  function startTimer(el, ms) {
    clearTimeout(el._timer);
    el._timer = setTimeout(() => hide(el), ms);
  }

  function toast(message, type = 'success', options = {}) {
    if (!message || !document.body) return null;
    if (!ICONS[type]) type = 'info';
    const { key, silent = false } = options;
    const duration = options.duration ?? (type === 'error' ? 6000 : 3500);
    const wrap = container();

    if (key) {
      wrap.querySelectorAll('.cb-toast').forEach(t => {
        if (t.dataset.key === key) { clearTimeout(t._timer); t.remove(); }
      });
    }

    const el = document.createElement('div');
    el.className = `cb-toast cb-toast--${type}`;
    if (key) el.dataset.key = key;
    if (silent) el.setAttribute('aria-hidden', 'true');

    const icon = document.createElement('span');
    icon.className = 'cb-toast__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ICONS[type];

    const text = document.createElement('span');
    text.className = 'cb-toast__msg';
    text.textContent = message;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cb-toast__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.title = 'Dismiss';
    close.textContent = '✕';
    if (silent) close.tabIndex = -1;
    close.addEventListener('click', () => hide(el));

    el.append(icon, text, close);
    wrap.appendChild(el);

    // Too many at once: the oldest ones go first.
    const shown = [...wrap.querySelectorAll('.cb-toast:not(.cb-toast--out)')];
    shown.slice(0, Math.max(0, shown.length - MAX_SHOWN)).forEach(hide);

    startTimer(el, duration);
    el.addEventListener('mouseenter', () => clearTimeout(el._timer));
    el.addEventListener('mouseleave', () => startTimer(el, 2000));
    el.addEventListener('focusin',    () => clearTimeout(el._timer));
    el.addEventListener('focusout',   () => startTimer(el, 2000));
    return el;
  }

  window.toast = toast;
})();
