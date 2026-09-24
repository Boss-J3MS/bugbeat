/* ═══════════════════════════════════════════════
   BUGBEAT — google-btn.js
   Keeps the "Sign in with Google" button the same width as the card's
   other controls (used by login.html and signup.html).

   Google draws its button at a fixed pixel width (data-width) and never
   resizes it by itself. So the width has to be measured from our own
   container, and checked again whenever that container changes size:
   browser zoom, resizing the window, a phone/emulator changing width.

   How it works:
   - The first width is set here before Google's script reads it.
   - After that, the width Google ACTUALLY drew with is read from the
     button iframe's src URL ("&width=NNN") and compared to the container.
     (Tracking our own "last width we asked for" isn't enough: Google reads
     data-width when its script loads but draws a moment later, so a resize
     in between used to leave the button stuck at the old width.)
   - When it doesn't match, a new button is drawn HIDDEN on top of the old
     one and only swapped in once it has finished loading. While Google's
     button is loading it briefly shows the Google account's own language
     (Filipino) before switching to English, even though it's asked for
     English (hl=en, confirmed in the console). Swapping only after it
     settles means that flash is never visible.

   Must be loaded as a normal (not async/defer) script placed after the
   #google-signin-btn markup and before Google's deferred gsi/client
   script, so the first data-width is set before Google reads it.
═══════════════════════════════════════════════ */
(function () {
  var container = document.getElementById('google-signin-btn');
  var widget = document.getElementById('g_id_signin_widget');
  if (!container || !widget) return;

  // How long the new button must go quiet (no DOM changes, no messages from
  // Google's iframe) after its iframe loads before it's shown. On a slow
  // connection Google's button can take most of a second after loading to
  // switch from the account's language to English.
  var SETTLE_MS = 1000;
  // Swap anyway after this long, in case the load event is missed.
  var GIVE_UP_MS = 8000;
  // How long zooming/resizing must pause before a redraw starts. Fast
  // zooming fires many size changes; redrawing on each one started several
  // Google buttons loading at once, which slowed all of them down and let
  // the last one be swapped in while it was still showing Filipino.
  var RESIZE_PAUSE_MS = 400;

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

  function iframeWidth(frame) {
    if (!frame || !frame.src) return null;
    try {
      var w = parseInt(new URL(frame.src).searchParams.get('width'), 10);
      return isNaN(w) ? null : w;
    } catch (e) {
      return null;
    }
  }

  // A redraw that's been started but not swapped in yet:
  // { slot, width, observer, settleTimer, giveUpTimer, onMessage }
  var pending = null;

  // The width the VISIBLE button was drawn with, or null if not drawn yet.
  function drawnWidth() {
    var frames = widget.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      if (pending && pending.slot.contains(frames[i])) continue;
      return iframeWidth(frames[i]);
    }
    return null;
  }

  function stopWatching(p) {
    p.observer.disconnect();
    clearTimeout(p.settleTimer);
    clearTimeout(p.giveUpTimer);
    if (p.onMessage) window.removeEventListener('message', p.onMessage);
  }

  function cancelPending() {
    if (!pending) return;
    stopWatching(pending);
    if (pending.slot.parentNode) pending.slot.parentNode.removeChild(pending.slot);
    pending = null;
  }

  // Show the new button and remove the old one. The new button's element
  // is not moved (moving an iframe reloads it), only un-hidden in place.
  function swapIn(p) {
    if (pending !== p) return;
    stopWatching(p);
    pending = null;

    var children = Array.prototype.slice.call(widget.childNodes);
    for (var i = 0; i < children.length; i++) {
      if (children[i] !== p.slot) widget.removeChild(children[i]);
    }
    p.slot.removeAttribute('style');
    p.slot.removeAttribute('aria-hidden');
    widget.setAttribute('data-width', String(p.width));
  }

  function redraw(w) {
    cancelPending();

    // Hidden slot sitting on top of the old button, same width as the
    // new button. visibility:hidden (not display:none) so Google still
    // lays it out and sizes it normally.
    widget.style.position = 'relative';
    var slot = document.createElement('div');
    slot.setAttribute('aria-hidden', 'true');
    slot.style.cssText =
      'position:absolute;left:0;top:0;width:' + w + 'px;' +
      'visibility:hidden;pointer-events:none;';
    widget.appendChild(slot);

    var p = { slot: slot, width: w, observer: null, settleTimer: null, giveUpTimer: null, onMessage: null };
    pending = p;

    var loaded = false;
    function restartSettle() {
      if (!loaded) return;
      clearTimeout(p.settleTimer);
      p.settleTimer = setTimeout(function () { swapIn(p); }, SETTLE_MS);
    }
    function watchFrame() {
      var frame = slot.querySelector('iframe');
      if (!frame || frame.__bbWatched) return;
      frame.__bbWatched = true;
      frame.addEventListener('load', function () {
        loaded = true;
        restartSettle();
      });
    }

    // Any further change Google makes to the new button restarts the wait.
    p.observer = new MutationObserver(function () {
      watchFrame();
      restartSettle();
    });
    p.observer.observe(slot, { childList: true, subtree: true, attributes: true });
    p.giveUpTimer = setTimeout(function () { swapIn(p); }, GIVE_UP_MS);

    // If Google's button iframe sends messages to the page while it
    // finishes drawing, treat those as "still busy" too. (Harmless if it
    // doesn't: the settle timer above still applies.)
    p.onMessage = function (e) {
      var frame = slot.querySelector('iframe');
      if (frame && e.source === frame.contentWindow) restartSettle();
    };
    window.addEventListener('message', p.onMessage);

    var d = widget.dataset;
    google.accounts.id.renderButton(slot, {
      type: d.type || 'standard',
      theme: d.theme || 'outline',
      size: d.size || 'large',
      text: d.text || 'continue_with',
      locale: d.locale || 'en',
      width: w
    });
    watchFrame();
  }

  function check() {
    var w = fitWidth();

    // A redraw is already on its way: leave it alone if it's for the
    // right width, otherwise it's replaced by a new one below.
    if (pending && Math.abs(w - pending.width) < 2) return;

    var drawn = drawnWidth();
    if (drawn === null || !googleReady()) {
      // Not drawn yet: keep data-width current. If Google already read an
      // older value, the check that runs when the button appears (below)
      // will catch the mismatch.
      widget.setAttribute('data-width', String(w));
      return;
    }
    if (Math.abs(w - drawn) >= 2) {
      redraw(w);
    } else if (pending) {
      // Resized back to the width that's already showing.
      cancelPending();
    }
  }

  var timer = null;
  function scheduleCheck() {
    clearTimeout(timer);
    // Wait until resizing/zooming settles instead of redrawing every frame.
    timer = setTimeout(check, RESIZE_PAUSE_MS);
  }

  // Container changed size (zoom, window resize, device width change).
  if ('ResizeObserver' in window) {
    new ResizeObserver(scheduleCheck).observe(container);
  } else {
    window.addEventListener('resize', scheduleCheck);
  }

  // Google drew the first button: make sure it used the right width.
  if ('MutationObserver' in window) {
    new MutationObserver(function (records) {
      // Ignore changes inside a hidden redraw that's still loading; those
      // are handled by that redraw's own observer.
      for (var i = 0; i < records.length; i++) {
        if (!pending || !pending.slot.contains(records[i].target) && records[i].target !== pending.slot) {
          scheduleCheck();
          return;
        }
      }
    }).observe(widget, { childList: true, subtree: true });
  }
})();
