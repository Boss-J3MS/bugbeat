// ═══════════════════════════════════════════════
//  settings.js — the Settings window (index.html)
//  Opened from ⚙ Settings in the sidebar. Three tabs:
//    • Profile:     nickname (saved to the account, once a week), username, email,
//                   sign-in method, member since.
//    • Preferences: Appearance (theme / text size / code size — wired up
//                   by appearance.js) and the default code language.
//    • Security:    Change password (opens account.js's window on top),
//                   signed-in devices (log out one, or all others), delete account.
//  Also shows the nickname (or the username) in the sidebar greeting.
//  Uses BACKEND_URL, cbToken and cbUser from app.js.
// ═══════════════════════════════════════════════
(function () {
  const modal   = document.getElementById('settings-modal');
  const openBtn = document.getElementById('settings-btn');
  if (!modal || !openBtn || typeof BACKEND_URL === 'undefined') return;

  const $ = (id) => document.getElementById(id);
  const closeBtn = $('settings-close-btn');
  const tabs     = [...modal.querySelectorAll('.cb-set__tab')];
  const DEFAULT_LANG_KEY = 'cb-default-lang';

  let me = null;          // latest /auth/me result
  let lastFocus = null;

  function authHeaders(json) {
    const h = { Authorization: `Bearer ${cbToken}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = 'cb-bugreport-modal__msg cb-bugreport-modal__msg--' + type;
    el.hidden = !text;
  }

  function niceError(err, fallback) {
    return err && err.message === 'Failed to fetch'
      ? 'Could not reach the server. Please try again.'
      : (err && err.message) || fallback;
  }

  // ── Who is logged in ───────────────────────────
  function displayName(u) {
    return (u && (u.nickname || u.username)) || '';
  }

  function updateGreeting(u) {
    const g = $('user-greeting');
    if (g && u) {
      g.textContent = displayName(u);
      g.title = u.nickname ? `${u.nickname} (@${u.username})` : u.username;
    }
  }

  // Keep the copy in localStorage up to date, so the greeting is right
  // straight away on the next page load.
  function cacheUser(u) {
    try {
      const saved = JSON.parse(localStorage.getItem('cb_user') || 'null') || {};
      localStorage.setItem('cb_user', JSON.stringify({ ...saved, nickname: u.nickname || null }));
    } catch (e) {}
  }

  async function loadMe() {
    const res = await fetch(`${BACKEND_URL}/auth/me`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Could not load your account.');
    const data = await res.json();
    me = data.user;
    updateGreeting(me);
    cacheUser(me);
    return me;
  }

  function formatDate(d) {
    const date = d ? new Date(d) : null;
    return date && !isNaN(date)
      ? date.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
      : '—';
  }

  function fillProfile(u) {
    $('set-avatar').textContent = (displayName(u) || '?').trim().charAt(0).toUpperCase();
    $('set-display-name').textContent = displayName(u) || '—';
    $('set-role').textContent = u.role === 'admin' ? 'Admin' : 'Member';
    $('set-nickname').value = u.nickname || '';
    showNickLock(u.nickname_next_change_at);
    $('set-username').textContent = u.username || '—';
    $('set-email').textContent = u.email || '—';
    $('set-method').textContent =
      u.has_google && u.has_password ? 'Google, or email and password'
      : u.has_google ? 'Google'
      : 'Email and password';
    $('set-since').textContent = formatDate(u.created_at);
    $('set-pw-text').textContent = u.has_password
      ? 'Change the password you log in with.'
      : 'Your account uses Google sign-in. Set a password to also log in with your email.';
    $('change-pw-btn').textContent = u.has_password ? '🔑 Change password' : '🔑 Set a password';
    $('set-delete-name').textContent = u.username || '';
    $('set-delete-pw-wrap').hidden = !u.has_password;
  }

  // Nickname can be changed once a week (the backend enforces it; this
  // just shows it). nextAt = when it can be changed again, or null.
  function showNickLock(nextAt) {
    const next = nextAt ? new Date(nextAt) : null;
    const locked = !!(next && next > new Date());
    $('set-nickname').disabled = locked;
    $('set-nick-save').disabled = locked;
    $('set-nick-hint').textContent = locked
      ? `You can change your nickname once a week. Next change: ${next.toLocaleString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`
      : 'Up to 30 characters, changeable once a week. Leave it empty to show your username.';
  }

  // ── Tabs ───────────────────────────────────────
  function selectTab(tab, focus) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('set-pane-' + t.dataset.pane).hidden = !on;
    });
    if (tab.dataset.pane === 'security' && typeof loadDevices === 'function') loadDevices();
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      selectTab(tabs[(i + d + tabs.length) % tabs.length], true);
    });
  });

  // ── Open / close ───────────────────────────────
  async function open(tabName) {
    lastFocus = document.activeElement;
    resetDelete();
    $('set-nick-msg').hidden = true;
    $('set-devices-msg').hidden = true;
    selectTab(tabs.find((t) => t.dataset.pane === (tabName || 'profile')) || tabs[0]);
    if (me) fillProfile(me);
    else if (typeof cbUser !== 'undefined' && cbUser) fillProfile({ ...cbUser, has_password: true });
    modal.hidden = false;
    closeBtn.focus();
    try { fillProfile(await loadMe()); } catch (e) { /* keep what we have */ }
  }

  function close() {
    modal.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  openBtn.addEventListener('click', () => open());
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  // Capture phase, so this runs before the password window's own Esc
  // handler: with the password window open on top, Esc closes only that.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || modal.hidden) return;
    const pw = $('pw-modal');
    if (pw && !pw.hidden) return;
    close();
  }, true);

  window.openSettings = open;

  // ── Profile: nickname ──────────────────────────
  $('set-nick-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('set-nick-msg');
    const btn = $('set-nick-save');
    const nickname = $('set-nickname').value.replace(/\s+/g, ' ').trim();
    if (nickname.length > 30) return showMsg(msg, 'Your nickname can be at most 30 characters.', 'error');
    if (/[<>]/.test(nickname)) return showMsg(msg, 'Your nickname cannot contain < or >.', 'error');
    btn.disabled = true;
    try {
      const res = await fetch(`${BACKEND_URL}/auth/profile`, {
        method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ nickname })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.nickname_next_change_at) {
          me = { ...(me || cbUser || {}), nickname_next_change_at: data.nickname_next_change_at };
          fillProfile(me);
        }
        throw new Error(data.error || 'Could not save your nickname.');
      }
      me = { ...(me || cbUser || {}), nickname: data.nickname, nickname_next_change_at: data.nickname_next_change_at };
      fillProfile(me);
      updateGreeting(me);
      cacheUser(me);
      showMsg(msg, data.message || 'Saved.', 'success');
    } catch (err) {
      showMsg(msg, niceError(err, 'Could not save your nickname.'), 'error');
    } finally {
      showNickLock(me && me.nickname_next_change_at);
    }
  });

  // ── Preferences: default language ─────────────
  const defaultLang = $('set-default-lang');
  const langSelect  = $('lang-select');
  let savedLang = 'auto';
  try { savedLang = localStorage.getItem(DEFAULT_LANG_KEY) || 'auto'; } catch (e) {}
  if (![...defaultLang.options].some((o) => o.value === savedLang)) savedLang = 'auto';
  defaultLang.value = savedLang;
  defaultLang.addEventListener('change', () => {
    try { localStorage.setItem(DEFAULT_LANG_KEY, defaultLang.value); } catch (e) {}
  });

  // Apply it when the page opens. The editor loads a little later, so
  // apply again once it exists (unless the user already picked another).
  if (langSelect && savedLang !== 'auto') {
    langSelect.value = savedLang;
    let tries = 0;
    const wait = setInterval(() => {
      tries++;
      if (typeof monacoEditor !== 'undefined' && monacoEditor) {
        clearInterval(wait);
        if (langSelect.value === savedLang) langSelect.dispatchEvent(new Event('change'));
      } else if (tries > 60) {
        clearInterval(wait);
      }
    }, 250);
  }

  // ── Security: signed-in devices ────────────────
  // GET /auth/sessions lists this account's devices (device, approximate
  // location, when it signed in and was last used). Each other device can
  // be logged out on its own, or all of them at once.
  const devList = $('set-devices-list');
  const DEVICE_ICONS = {
    computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>',
    phone:    '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>',
    tablet:   '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>'
  };

  function ago(d) {
    return typeof timeAgo === 'function' ? timeAgo(d) : formatDate(d);
  }
  function shortDate(d) {
    const date = d ? new Date(d) : null;
    return date && !isNaN(date)
      ? date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
  }

  function devNote(text) {
    devList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'cb-devices__note';
    li.textContent = text;
    devList.appendChild(li);
  }

  function renderDevices(list) {
    devList.innerHTML = '';
    if (!list.length) return devNote('No signed-in devices.');
    list.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'cb-device' + (s.current ? ' cb-device--current' : '');

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('class', 'cb-ico cb-device__icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = DEVICE_ICONS[s.type] || DEVICE_ICONS.computer;

      const body = document.createElement('div');
      body.className = 'cb-device__body';
      const name = document.createElement('div');
      name.className = 'cb-device__name';
      name.textContent = s.device || 'Unknown device';
      if (s.current) {
        const tag = document.createElement('span');
        tag.className = 'cb-device__tag';
        tag.textContent = 'This device';
        name.appendChild(tag);
      }
      const meta = document.createElement('div');
      meta.className = 'cb-device__meta';
      meta.textContent = [
        s.location || 'Unknown location',
        s.current ? 'Active now' : (s.last_active ? `Active ${ago(s.last_active)}` : ''),
        s.signed_in ? `Signed in ${shortDate(s.signed_in)}` : ''
      ].filter(Boolean).join(' · ');
      body.append(name, meta);
      li.append(icon, body);

      if (!s.current) {
        const out = document.createElement('button');
        out.type = 'button';
        out.className = 'cb-btn cb-btn--ghost cb-device__out';
        out.textContent = 'Log out';
        out.setAttribute('aria-label', `Log out ${s.device || 'this device'}`);
        out.addEventListener('click', () => logoutDevice(s, li, out));
        li.appendChild(out);
      }
      devList.appendChild(li);
    });
    $('set-logout-others').disabled = !list.some((s) => !s.current);
  }

  async function loadDevices() {
    devNote('Loading…');
    try {
      const res = await fetch(`${BACKEND_URL}/auth/sessions`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not load your devices.');
      renderDevices(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (err) {
      devNote(niceError(err, 'Could not load your devices.'));
    }
  }

  async function logoutDevice(s, li, btn) {
    const msg = $('set-devices-msg');
    btn.disabled = true;
    li.classList.add('cb-device--busy');
    try {
      const res = await fetch(`${BACKEND_URL}/auth/sessions/${encodeURIComponent(s.id)}`, {
        method: 'DELETE', headers: authHeaders()
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 404) throw new Error(data.error || 'Could not log out that device.');
      showMsg(msg, `Logged out ${s.device || 'that device'}.`, 'success');
      loadDevices();
    } catch (err) {
      li.classList.remove('cb-device--busy');
      btn.disabled = false;
      showMsg(msg, niceError(err, 'Could not log out that device.'), 'error');
    }
  }

  $('set-logout-others').addEventListener('click', async () => {
    const btn = $('set-logout-others');
    const msg = $('set-devices-msg');
    btn.disabled = true;
    try {
      const res = await fetch(`${BACKEND_URL}/auth/logout-others`, { method: 'POST', headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not log out your other devices.');
      showMsg(msg, data.message || 'Done.', 'success');
    } catch (err) {
      showMsg(msg, niceError(err, 'Could not log out your other devices.'), 'error');
    } finally {
      btn.disabled = false;
      loadDevices();
    }
  });

  // ── Security: delete account ───────────────────
  const delForm   = $('set-delete-form');
  const delStart  = $('set-delete-start');
  const delUser   = $('set-delete-username');
  const delPw     = $('set-delete-password');
  const delBtn    = $('set-delete-confirm');
  const delMsg    = $('set-delete-msg');

  function resetDelete() {
    delForm.hidden = true;
    delStart.hidden = false;
    delForm.reset();
    delMsg.hidden = true;
    delBtn.disabled = true;
  }

  function checkDelete() {
    const name = (me && me.username) || (cbUser && cbUser.username) || '';
    const needsPw = !$('set-delete-pw-wrap').hidden;
    delBtn.disabled = delUser.value.trim() !== name || (needsPw && !delPw.value);
  }

  delStart.addEventListener('click', () => {
    delStart.hidden = true;
    delForm.hidden = false;
    delUser.focus();
  });
  $('set-delete-cancel').addEventListener('click', () => { resetDelete(); delStart.focus(); });
  delUser.addEventListener('input', checkDelete);
  delPw.addEventListener('input', checkDelete);

  delForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    checkDelete();
    if (delBtn.disabled) return;
    delBtn.disabled = true;
    delBtn.textContent = 'Deleting…';
    try {
      const res = await fetch(`${BACKEND_URL}/auth/account`, {
        method: 'DELETE',
        headers: authHeaders(true),
        body: JSON.stringify({ username: delUser.value.trim(), password: delPw.value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete your account.');
      showMsg(delMsg, 'Your account has been deleted. Goodbye!', 'success');
      try {
        localStorage.removeItem('cb_token');
        localStorage.removeItem('cb_user');
      } catch (err) {}
      setTimeout(() => { window.location.href = 'login.html'; }, 1500);
    } catch (err) {
      delBtn.textContent = 'Delete permanently';
      showMsg(delMsg, niceError(err, 'Could not delete your account.'), 'error');
      checkDelete();
    }
  });

  // ── On page load ───────────────────────────────
  // Show the saved nickname straight away, then refresh from the server.
  if (typeof cbUser !== 'undefined' && cbUser) updateGreeting(cbUser);
  loadMe().catch(() => {});
})();
