// ═══════════════════════════════════════════════
//  popover.js — keeps header dropdowns on screen
//  The notifications dropdown and the ☰ menu are anchored to the right
//  edge of their button. When the header wraps (zoomed in, narrow
//  window), the bell / ☰ can end up at the left of the second row, and
//  a right-anchored panel then sticks out past the left edge of the
//  window, where it's cut off and can't be used. keepInView() is called
//  right after a panel opens: it measures where the panel landed and,
//  if any part is off screen, slides it back in. It's re-checked when
//  the window is resized or zoomed while the panel is open.
// ═══════════════════════════════════════════════
(function () {
  const MARGIN = 8;          // px kept between the panel and the window edge
  const tracked = new Set();

  function place(panel) {
    // Start from the position the stylesheet gives it.
    panel.style.left  = '';
    panel.style.right = '';
    if (panel.hidden) return;

    const viewport = document.documentElement.clientWidth;
    const rect     = panel.getBoundingClientRect();
    let shift = 0;
    if (rect.right > viewport - MARGIN) shift = (viewport - MARGIN) - rect.right;  // move left
    if (rect.left + shift < MARGIN)     shift = MARGIN - rect.left;                // move right
    if (shift) {
      const left = panel.offsetLeft + shift;   // read before changing styles
      panel.style.right = 'auto';
      panel.style.left  = `${left}px`;
    }
  }

  window.keepInView = function (panel) {
    if (!panel) return;
    tracked.add(panel);
    place(panel);
  };

  window.addEventListener('resize', () => tracked.forEach(place));

  // The header can also re-wrap without the window changing size (e.g. a
  // status message appears next to the search bar while the ☰ menu is
  // open), which moves the buttons the panels hang from. Watch the header
  // and re-place any open panel when its size changes.
  const header = document.querySelector('.cb-header');
  if (header && 'ResizeObserver' in window) {
    new ResizeObserver(() => tracked.forEach(place)).observe(header);
  }
})();
