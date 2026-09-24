/* ═══════════════════════════════════════════════
   BUGBEAT — google-btn.js
   Keeps the "Sign in with Google" button the same width as the card's
   other controls (used by login.html and signup.html).

   Google draws its button at a fixed pixel width (data-width) and never
   resizes it by itself. So the width has to be measured from our own
   container, and measured again whenever that container changes size:
   browser zoom (e.g. 100% -> 125%), resizing the window, rotating a phone.
   Otherwise the button keeps its old width and sticks out past the
   Log in button.

   Must be loaded as a normal (not async/defer) script placed after the
   #google-signin-btn markup and before Google's deferred gsi/client
   script, so the first data-width is set before Google reads it.
═══════════════════════════════════════════════ */
(function () {
  var container = document.getElementById('google-signin-btn');
  var widget = document.getElementById('g_id_signin_widget');
  if (!container || !widget) return;

  // Google accepts widths from 200 to 400px.
  function fitWidth() {
    var w = Math.floor(container.getBoundingClientRect().width);
    return Math.max(200, Math.min(w, 400));
  }

  var renderedWidth = fitWidth();
  widget.setAttribute('data-width', String(renderedWidth));

  if (!('ResizeObserver' in window)) return;

  function googleReady() {
    return !!(window.google && google.accounts && google.accounts.id);
  }

  function rerender(w) {
    renderedWidth = w;
    widget.setAttribute('data-width', String(w));

    // Google's script hasn't drawn the button yet: updating data-width is
    // enough, it will be read when the button is first drawn.
    if (!googleReady() || !widget.firstElementChild) return;

    // Already drawn: clear it and draw it again at the new width, using
    // the same settings as the data-* attributes in the HTML.
    var d = widget.dataset;
    widget.innerHTML = '';
    google.accounts.id.renderButton(widget, {
      type: d.type || 'standard',
      theme: d.theme || 'outline',
      size: d.size || 'large',
      text: d.text || 'continue_with',
      locale: d.locale || 'en',
      width: w
    });
  }

  var timer = null;
  new ResizeObserver(function () {
    clearTimeout(timer);
    // Wait until resizing/zooming settles instead of redrawing every frame.
    timer = setTimeout(function () {
      var w = fitWidth();
      if (Math.abs(w - renderedWidth) >= 2) rerender(w);
    }, 150);
  }).observe(container);
})();
