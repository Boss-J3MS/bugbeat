// ═══════════════════════════════════════════════
//  logout.js — "Are you sure you want to log out?" confirmation
//  Used by index.html and admin.html. Clicking #logout-btn opens a small
//  confirmation window instead of logging out straight away. Confirming
//  ends the session on the server (POST /auth/logout), clears the saved
//  login from this browser, and goes to the login page.
//  Adds its own window markup, reusing the bug-report modal styles from
//  style.css, so each page only needs <script src="logout.js">.
// ═══════════════════════════════════════════════
(function () {
  const logoutBtn = document.getElementById('logout-btn');
  if (!logoutBtn) return;

  const API =
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'http://localhost:3000'
      : 'https://bugbeat.onrender.com';

  const modal = document.createElement('div');
  modal.id = 'logout-modal';
  modal.className = 'cb-bugreport-modal';
  modal.hidden = true;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'logout-modal-title');
  modal.innerHTML = `
    <div class="cb-bugreport-modal__box cb-logout-modal__box">
      <div class="cb-bugreport-modal__header">
        <span id="logout-modal-title" class="cb-bugreport-modal__title">Are you sure you want to log out?</span>
      </div>
      <p class="cb-bugreport-modal__hint">You'll need to log in again to use BugBeat.</p>
      <div class="cb-bugreport-modal__actions">
        <button type="button" id="logout-cancel-btn" class="cb-btn cb-btn--ghost">Cancel</button>
        <button type="button" id="logout-confirm-btn" class="cb-btn cb-btn--primary">Log out</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const cancelBtn  = modal.querySelector('#logout-cancel-btn');
  const confirmBtn = modal.querySelector('#logout-confirm-btn');

  function open() {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Log out';
    modal.hidden = false;
    // Cancel is focused first, so an accidental Enter doesn't log out.
    cancelBtn.focus();
  }

  function close() {
    modal.hidden = true;
    // On the main page Logout sits inside the ☰ menu, which closes when
    // it's clicked; return focus to the menu button in that case.
    const back = logoutBtn.offsetParent ? logoutBtn : document.getElementById('menu-btn');
    if (back) back.focus();
  }

  async function logOut() {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Logging out…';
    const token = localStorage.getItem('cb_token');

    // End the session on the server too, so the token stops working even
    // if it was copied somewhere. Don't wait more than a few seconds (the
    // backend may be waking up); the local logout below happens anyway.
    if (token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        await fetch(`${API}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
      } catch (e) {
        // Offline / timed out: still log out locally.
      } finally {
        clearTimeout(timer);
      }
    }

    localStorage.removeItem('cb_token');
    localStorage.removeItem('cb_user');
    window.location.href = 'login.html';
  }

  logoutBtn.addEventListener('click', open);
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', logOut);
  // Clicking the dark backdrop or pressing Esc cancels.
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden && !confirmBtn.disabled) close();
  });
})();
