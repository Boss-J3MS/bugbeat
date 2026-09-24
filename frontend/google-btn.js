/* ═══════════════════════════════════════════════
   BUGBEAT — google-btn.js
   Keeps the "Sign in with Google" button the same width as the card's
   other controls (used by login.html and signup.html).

   Google draws its button at a fixed pixel width (data-width) and never
   resizes it by itself. So the width has to be measured from our own
   container, and checked again whenever that container changes size:
   browser zoom, resizing the window, a phone/emulator changing width.

   The width check compares against the width Google ACTUALLY drew with,
   read from the button iframe's src URL (it contains "&width=NNN").
   Tracking our own "last width we asked for" isn't enough: Google reads
   data-width as soon as its script loads but only draws the button a
   moment later, so a resize in between left the button stuck at the old
   width while we thought it had been updated.

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

  // First width, read by Google's script when it loads.
  widget.setAttribute('data-width', String(fitWidth()));

  function googleReady() {
    return !!(window.google && google.accounts && google.accounts.id);
  }

  // The width the currently visible button was drawn with, or null if
  // Google hasn't drawn it yet.
  function drawnWidth() {
    var frame = widget.querySelector('iframe');
    if (!frame || !frame.src) return null;
    try {
      var w = parseInt(new URL(frame.src).searchParams.get('width'), 10);
      return isNaN(w) ? null : w;
    } catch (e) {
      return null;
    }
  }

  function redraw(w) {
    var d = widget.dataset;
    widget.setAttribute('data-width', String(w));
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

  function check() {
    var w = fitWidth();
    var drawn = drawnWidth();

    if (drawn === null || !googleReady()) {
      // Not drawn yet: keep data-width current. If Google already read an
      // older value, the check that runs when the button appears (below)
      // will catch the mismatch.
      widget.setAttribute('data-width', String(w));
      return;
    }
    if (Math.abs(w - drawn) >= 2) redraw(w);
  }

  var timer = null;
  function scheduleCheck() {
    clearTimeout(timer);
    // Wait until resizing/zooming settles instead of redrawing every frame.
    timer = setTimeout(check, 150);
  }

  // Container changed size (zoom, window resize, device width change).
  if ('ResizeObserver' in window) {
    new ResizeObserver(scheduleCheck).observe(container);
  } else {
    window.addEventListener('resize', scheduleCheck);
  }

  // Google drew (or redrew) the button: make sure it used the right width.
  if ('MutationObserver' in window) {
    new MutationObserver(scheduleCheck).observe(widget, { childList: true, subtree: true });
  }
})();
