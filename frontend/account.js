// ═══════════════════════════════════════════════
//  account.js — "Change password" window (index.html)
//  Opened from ☰ menu → Account → Change password.
//  Accounts created with Google sign-in have no password yet; for them
//  the same window becomes "Set a password" (no current-password field).
//  Uses BACKEND_URL and cbToken from app.js.
// ═══════════════════════════════════════════════
(function () {
  const openBtn   = document.getElementById('change-pw-btn');
  const modal     = document.getElementById('pw-modal');
  const form      = document.getElementById('pw-form');
  if (!openBtn || !modal || !form) return;

  const title       = document.getElementById('pw-modal-title');
  const hint        = document.getElementById('pw-hint');
  const currentWrap = document.getElementById('pw-current-field');
  const currentIn   = document.getElementById('pw-current');
  const newIn       = document.getElementById('pw-new');
  const confirmIn   = document.getElementById('pw-confirm');
  const msg         = document.getElementById('pw-msg');
  const submitBtn   = document.getElementById('pw-submit-btn');
  const closeBtn    = document.getElementById('pw-close-btn');
  const cancelBtn   = document.getElementById('pw-cancel-btn');

  // Whether the account already has a password. Refreshed from
  // /auth/me each time the window opens; assume yes until we know.
  let hasPassword = true;
  let closeTimer = null;

  function showMsg(text, type) {
    msg.textContent = text;
    msg.className = 'cb-bugreport-modal__msg cb-bugreport-modal__msg--' + type;
    msg.hidden = false;
  }

  function setMode(withPassword) {
    hasPassword = withPassword;
    currentWrap.hidden = !withPassword;
    title.textContent = withPassword ? 'Change password' : 'Set a password';
    hint.textContent = withPassword
      ? 'Other devices signed in to your account will be logged out.'
      : 'Your account signs in with Google. Set a password to also log in with your email and password.';
    submitBtn.textContent = withPassword ? 'Save password' : 'Set password';
  }

  function resetForm() {
    form.reset();
    msg.hidden = true;
    submitBtn.disabled = false;
    form.querySelectorAll('.cb-pwfield__toggle').forEach((btn) => {
      document.getElementById(btn.dataset.target).type = 'password';
      btn.textContent = 'Show';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', 'Show password');
    });
  }

  async function openModal() {
    clearTimeout(closeTimer);
    resetForm();
    setMode(true);
    modal.hidden = false;
    currentIn.focus();
    try {
      const res = await fetch(`${BACKEND_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${cbToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.user && data.user.has_password === false) {
          setMode(false);
          newIn.focus();
        }
      }
    } catch (e) {
      // Offline or backend asleep: keep the normal "change" form.
    }
  }

  function closeModal() {
    clearTimeout(closeTimer);
    modal.hidden = true;
    openBtn.focus();
  }

  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  // Click on the dark backdrop (not the box) closes it.
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // Show/Hide buttons on each password field.
  form.querySelectorAll('.cb-pwfield__toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', (show ? 'Hide' : 'Show') + ' password');
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.hidden = true;

    const currentPassword = currentIn.value;
    const newPassword = newIn.value;

    // Same rules as the backend, checked here first for quicker feedback.
    if (hasPassword && !currentPassword) {
      return showMsg('Please enter your current password.', 'error');
    }
    if (newPassword.length < 8) {
      return showMsg('Your new password must be at least 8 characters long.', 'error');
    }
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return showMsg('Your new password must contain at least one letter and one number.', 'error');
    }
    if (newPassword !== confirmIn.value) {
      return showMsg('The new passwords do not match.', 'error');
    }

    submitBtn.disabled = true;
    const label = submitBtn.textContent;
    submitBtn.textContent = 'Saving…';
    try {
      const res = await fetch(`${BACKEND_URL}/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cbToken}`
        },
        body: JSON.stringify(hasPassword ? { currentPassword, newPassword } : { newPassword })
      });
      const data = await res.json().catch(() => ({}));
      submitBtn.textContent = label;
      if (!res.ok) {
        throw new Error(data.error || 'Could not change your password. Please try again.');
      }
      showMsg(data.message || 'Password saved.', 'success');
      form.querySelectorAll('input').forEach((i) => { i.value = ''; });
      hasPassword = true; // the account has a password now
      closeTimer = setTimeout(closeModal, 2200);
    } catch (err) {
      submitBtn.textContent = label;
      showMsg(err.message === 'Failed to fetch'
        ? 'Could not reach the server. Please try again.'
        : err.message, 'error');
      submitBtn.disabled = false;
    }
  });
})();
