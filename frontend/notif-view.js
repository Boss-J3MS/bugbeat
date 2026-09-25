// ═══════════════════════════════════════════════
//  notif-view.js — the full notifications view (index.html #nv-modal)
//  • openNotification(n): shows one notification on its own: the whole
//    message, the exact time, and a button to go to what it's about
//    (the analysis in History, or the Admin page). Opening it marks it
//    read.
//  • openAllNotifications(): lists all of your notifications (up to
//    100), with an All / Unread filter and "Mark all read". Clicking one
//    opens it as above; "← All notifications" goes back to the list.
//  The 🔔 dropdown (app.js) stays the quick view of the latest 20; this
//  keeps it in sync when something is marked read here.
// ═══════════════════════════════════════════════
(function () {
  const modal      = document.getElementById('nv-modal');
  if (!modal) return;

  const titleEl    = document.getElementById('nv-title');
  const backBtn    = document.getElementById('nv-back');
  const closeBtn   = document.getElementById('nv-close');
  const doneBtn    = document.getElementById('nv-done');
  const listView   = document.getElementById('nv-list-view');
  const listEl     = document.getElementById('nv-list');
  const markAllBtn = document.getElementById('nv-mark-all');
  const detailView = document.getElementById('nv-detail-view');
  const iconEl     = document.getElementById('nv-detail-icon');
  const kindEl     = document.getElementById('nv-detail-kind');
  const timeEl     = document.getElementById('nv-detail-time');
  const msgEl      = document.getElementById('nv-detail-msg');
  const extraEl    = document.getElementById('nv-detail-extra');
  const actionBtn  = document.getElementById('nv-action');

  let all        = [];      // notifications shown in the list view
  let filter     = 'all';
  let cameFromList = false; // show "← All notifications" in the detail view
  let lastFocus  = null;
  let detailToken = 0;      // ignores a slow analysis fetch after moving on

  const user = (() => {
    try { return JSON.parse(localStorage.getItem('cb_user') || 'null'); } catch { return null; }
  })();

  // ── Helpers ──────────────────────────────────
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function ago(dateStr) {
    return typeof timeAgo === 'function' ? timeAgo(dateStr) : '';
  }

  function fullDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-PH', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  // What kind of notification this is, and where its button goes.
  function describe(n) {
    const msg = n.message || '';
    if (n.type === 'analysis') {
      return {
        icon: '📊',
        kind: 'Analysis complete',
        action: n.analysis_id ? { label: 'View analysis', run: () => viewAnalysis(n.analysis_id) } : null
      };
    }
    if (/now a BugBeat admin/i.test(msg)) {
      return {
        icon: '⚙',
        kind: 'Admin access',
        action: user?.role === 'admin' ? { label: 'Open Admin page', run: () => { window.location.href = 'admin.html'; } } : null
      };
    }
    if (/^Welcome to BugBeat/i.test(msg)) {
      return { icon: '👋', kind: 'Welcome', action: null };
    }
    return { icon: '🔔', kind: 'Notification', action: null };
  }

  // ── Open / close ─────────────────────────────
  function showModal() {
    if (modal.hidden) {
      lastFocus = document.activeElement;
      modal.hidden = false;
    }
  }

  function closeModal() {
    if (modal.hidden) return;
    modal.hidden = true;
    detailToken++;
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  closeBtn.addEventListener('click', closeModal);
  doneBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
  backBtn.addEventListener('click', () => showList());

  // ── Marking read (kept in sync with the 🔔 dropdown) ──
  async function markRead(n) {
    if (!n || n.is_read) return;
    const inDropdown = typeof notifications !== 'undefined' && notifications.find(x => x.id === n.id);
    if (inDropdown && !inDropdown.is_read && typeof markNotificationRead === 'function') {
      // app.js updates the dropdown + badge and tells the backend.
      const done = markNotificationRead(n.id);
      n.is_read = 1;
      await done;
      return;
    }
    n.is_read = 1;
    if (inDropdown) return;   // already marked read there
    try {
      const res = await fetch(`${BACKEND_URL}/notifications/${n.id}/read`, {
        method: 'PATCH', headers: authHeaders()
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn('Could not mark notification as read:', err.message);
    }
  }

  markAllBtn.addEventListener('click', async () => {
    if (!all.some(n => !n.is_read)) return;
    all.forEach(n => { n.is_read = 1; });
    renderList();
    // Same button logic as the dropdown's "Mark all read" (app.js), which
    // also updates the badge and calls the backend.
    const dropdownBtn = document.getElementById('notif-mark-all');
    if (typeof notifications !== 'undefined' && notifications.some(n => !n.is_read) && dropdownBtn) {
      dropdownBtn.click();
      return;
    }
    try {
      await fetch(`${BACKEND_URL}/notifications/read-all`, { method: 'PATCH', headers: authHeaders() });
    } catch (err) {
      console.warn('Could not mark all notifications as read:', err.message);
    }
  });

  // ── List view ────────────────────────────────
  modal.querySelectorAll('.cb-nv__filter').forEach(btn => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      modal.querySelectorAll('.cb-nv__filter').forEach(b => b.classList.toggle('active', b === btn));
      renderList();
    });
  });

  function renderList() {
    const shown = filter === 'unread' ? all.filter(n => !n.is_read) : all;
    markAllBtn.disabled = !all.some(n => !n.is_read);
    if (!shown.length) {
      listEl.innerHTML = `<div class="cb-notif__empty">${filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}</div>`;
      return;
    }
    listEl.innerHTML = shown.map(n => {
      const d = describe(n);
      return `
        <button type="button" class="cb-nv__item${n.is_read ? '' : ' cb-nv__item--unread'}" data-id="${esc(n.id)}">
          <span class="cb-nv__item-icon" aria-hidden="true">${d.icon}</span>
          <span class="cb-nv__item-body">
            <span class="cb-nv__item-msg">${esc(n.message)}</span>
            <span class="cb-nv__item-time">${esc(ago(n.created_at))}</span>
          </span>
          ${n.is_read ? '' : '<span class="cb-nv__dot" aria-label="Unread"></span>'}
        </button>`;
    }).join('');
  }

  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('.cb-nv__item');
    if (!item) return;
    const n = all.find(x => String(x.id) === item.dataset.id);
    if (n) showDetail(n, true);
  });

  function showList() {
    detailToken++;
    titleEl.textContent = 'Notifications';
    backBtn.hidden = true;
    titleEl.hidden = false;
    detailView.hidden = true;
    listView.hidden = false;
    renderList();
  }

  async function loadAll() {
    listEl.innerHTML = '<div class="cb-notif__empty">Loading…</div>';
    try {
      const res  = await fetch(`${BACKEND_URL}/notifications?limit=100`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.notifications)) throw new Error(data.error || `HTTP ${res.status}`);
      all = data.notifications;
      // Anything just marked read in the dropdown may not have reached
      // the server before this list was fetched.
      if (typeof notifications !== 'undefined') {
        all.forEach(n => {
          const d = notifications.find(x => x.id === n.id);
          if (d && d.is_read) n.is_read = 1;
        });
      }
      renderList();
    } catch (err) {
      console.warn('Could not load notifications:', err.message);
      // Fall back to what the dropdown already has rather than an error.
      all = (typeof notifications !== 'undefined' && Array.isArray(notifications)) ? notifications.slice() : [];
      renderList();
    }
  }

  // ── Detail view ──────────────────────────────
  function showDetail(n, withBack) {
    cameFromList = !!withBack;
    const token = ++detailToken;
    const d = describe(n);

    titleEl.hidden   = cameFromList;
    titleEl.textContent = 'Notification';
    backBtn.hidden   = !cameFromList;
    listView.hidden  = true;
    detailView.hidden = false;

    iconEl.textContent = d.icon;
    kindEl.textContent = d.kind;
    const when = fullDate(n.created_at);
    const rel  = ago(n.created_at);
    timeEl.textContent = rel && when ? `${when} · ${rel}` : (when || rel);
    msgEl.textContent  = n.message || '';

    extraEl.hidden = true;
    extraEl.innerHTML = '';
    if (d.action) {
      actionBtn.textContent = d.action.label;
      actionBtn.onclick = d.action.run;
      actionBtn.hidden = false;
    } else {
      actionBtn.onclick = null;
      actionBtn.hidden = true;
    }

    markRead(n).then(() => { if (cameFromList && token === detailToken) renderList(); });
    if (n.type === 'analysis' && n.analysis_id) loadAnalysisSummary(n.analysis_id, token);
  }

  // A short summary of the analysis under the message.
  async function loadAnalysisSummary(id, token) {
    extraEl.hidden = false;
    extraEl.innerHTML = '<span class="cb-nv__extra-loading">Loading analysis…</span>';
    try {
      const res  = await fetch(`${BACKEND_URL}/history/${encodeURIComponent(id)}`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (token !== detailToken) return;
      if (!res.ok || !data.analysis) throw new Error(data.error || `HTTP ${res.status}`);
      const a = data.analysis;
      const score = parseFloat(a.fusion_score || 0);
      extraEl.innerHTML = `
        <div class="cb-nv__facts">
          <div><span>Language</span><strong>${esc(a.language || '—')}</strong></div>
          <div><span>Lines</span><strong>${esc(a.total_lines ?? '—')}</strong></div>
          <div><span>Issues</span><strong>${esc(a.issues_found ?? '—')}</strong></div>
          <div><span>Risk</span><strong>${esc(a.risk_level || '—')}</strong></div>
          <div><span>Score</span><strong>${isNaN(score) ? '—' : score.toFixed(2)}</strong></div>
        </div>`;
    } catch (err) {
      if (token !== detailToken) return;
      // The analysis may have been removed; the message itself still shows.
      extraEl.innerHTML = '<span class="cb-nv__extra-loading">This analysis is no longer available.</span>';
      actionBtn.hidden = true;
    }
  }

  function viewAnalysis(id) {
    closeModal();
    if (typeof openHistorySession === 'function') openHistorySession(id);
  }

  // ── Public ───────────────────────────────────
  window.openNotification = function (n) {
    showModal();
    showDetail(n, true);   // with "← All notifications" to see the rest
    // Load the full list in the background so it's ready if they go back.
    loadAll();
    doneBtn.focus();
  };

  window.openAllNotifications = function () {
    showModal();
    showList();
    loadAll();
    closeBtn.focus();
  };
})();
