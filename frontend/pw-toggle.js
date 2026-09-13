/* ═══════════════════════════════════════════════
   CODEBEAT — pw-toggle.js
   Show/hide toggle for password fields on the auth pages.
═══════════════════════════════════════════════ */
(function () {
  document.querySelectorAll('.auth-field__toggle-pw').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.getAttribute('data-target'));
      if (!input) return;
      var willShow = input.type === 'password';
      input.type = willShow ? 'text' : 'password';
      btn.textContent = willShow ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(willShow));
      btn.setAttribute('aria-label', (willShow ? 'Hide' : 'Show') + ' password');
    });
  });
})();
