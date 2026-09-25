// ═══════════════════════════════════════════════
//  banner.js — broadcast banner at the top of the main page
//  Shows the admin broadcasts that are still active
//  (GET /announcements/active). Each has a ✕; a dismissed one stays
//  hidden in this browser (remembered in localStorage), and comes back
//  only if the browser forgets it. Checks again every few minutes so a
//  new maintenance notice shows up without a reload.
// ═══════════════════════════════════════════════
(function () {
  const ICONS = { info: 'ℹ️', maintenance: '🛠️', update: '✨' };
  const LABELS = { info: 'Announcement', maintenance: 'Maintenance', update: 'Update' };
  const STORE_KEY = 'cb-dismissed-announcements';
  const CHECK_EVERY_MS = 5 * 60 * 1000;

  const header = document.querySelector('.cb-header');
  if (!header || typeof BACKEND_URL === 'undefined') return;

  const box = document.createElement('div');
  box.className = 'cb-announcements';
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'Announcements');
  header.insertAdjacentElement('afterend', box);

  function dismissed() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
  }
  function dismiss(id) {
    try {
      const ids = dismissed().filter(x => x !== id);
      ids.push(id);
      localStorage.setItem(STORE_KEY, JSON.stringify(ids.slice(-50)));
    } catch { /* private window etc.: it just comes back next load */ }
  }

  function render(list) {
    const hidden = new Set(dismissed());
    box.innerHTML = '';
    list.filter(a => !hidden.has(a.id)).forEach(a => {
      const kind = ICONS[a.kind] ? a.kind : 'info';
      const el = document.createElement('div');
      el.className = `cb-announce cb-announce--${kind}`;
      el.setAttribute('role', kind === 'maintenance' ? 'alert' : 'status');

      const icon = document.createElement('span');
      icon.className = 'cb-announce__icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = ICONS[kind];

      const text = document.createElement('div');
      text.className = 'cb-announce__text';
      const title = document.createElement('strong');
      title.className = 'cb-announce__title';
      title.textContent = a.title;
      const msg = document.createElement('span');
      msg.className = 'cb-announce__msg';
      msg.textContent = a.message;
      text.append(title, msg);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'cb-announce__close';
      close.setAttribute('aria-label', `Dismiss ${LABELS[kind].toLowerCase()}`);
      close.title = 'Dismiss';
      close.textContent = '✕';
      close.addEventListener('click', () => { dismiss(a.id); el.remove(); });

      el.append(icon, text, close);
      box.appendChild(el);
    });
  }

  async function check() {
    try {
      const res  = await fetch(`${BACKEND_URL}/announcements/active`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.announcements)) render(data.announcements);
    } catch (err) {
      // Server asleep or offline: keep whatever is showing.
    }
  }

  let lastCheck = 0;
  function checkIfDue(minGapMs) {
    if (document.hidden || Date.now() - lastCheck < minGapMs) return;
    lastCheck = Date.now();
    check();
  }
  checkIfDue(0);
  setInterval(() => checkIfDue(CHECK_EVERY_MS - 1000), CHECK_EVERY_MS);
  // Coming back to the tab: check again, but not more than once a minute.
  document.addEventListener('visibilitychange', () => checkIfDue(60 * 1000));
})();
