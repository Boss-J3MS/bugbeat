// ═══════════════════════════════════════════════
//  tracks.js — "My tracks" in the ☰ menu (Sound section)
//  Uploaded backing tracks are saved to the user's account (backend
//  /audio routes, stored in Cloudflare R2), so they can be used again on
//  any device. Lists the saved tracks, loads one as the backing track
//  (through app.js's useAudioTrack), deletes them, and saves a newly
//  picked file (app.js calls saveTrackToAccount after it decodes it).
// ═══════════════════════════════════════════════
(function () {
  const box     = document.getElementById('tracks');
  const listEl  = document.getElementById('tracks-list');
  const countEl = document.getElementById('tracks-count');
  const msgEl   = document.getElementById('tracks-msg');
  const menuBtn = document.getElementById('menu-btn');
  if (!box || !listEl || typeof BACKEND_URL === 'undefined') return;

  let tracks   = [];
  let limits   = { enabled: false, max_files: 5, max_bytes: 15 * 1024 * 1024 };
  let loaded   = false;
  let activeId = null;     // the saved track currently used as backing track
  let busy     = false;    // an upload or download is running

  function authOnly() {
    const h = typeof authHeaders === 'function' ? authHeaders() : {};
    delete h['Content-Type'];
    return h;
  }

  function sizeText(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function showMsg(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = `cb-tracks__msg${kind ? ' cb-tracks__msg--' + kind : ''}`;
    msgEl.hidden = !text;
  }

  async function errorText(res, fallback) {
    const data = await res.json().catch(() => ({}));
    return (data.error || fallback) + (data.ref ? ` (code: ${data.ref})` : '');
  }

  function mbText(bytes) {
    return `${Math.round(bytes / 1024 / 1024)} MB`;
  }

  // Opens the ☰ menu at My tracks (used by the "My tracks is full" pop-up).
  function openMyTracks() {
    const panel = document.getElementById('menu-panel');
    if (panel && panel.hidden && menuBtn) menuBtn.click();
    box.scrollIntoView({ block: 'nearest' });
    box.classList.add('cb-tracks--flash');
    setTimeout(() => box.classList.remove('cb-tracks--flash'), 1600);
  }

  function showFullNotice(name) {
    if (typeof showNotice !== 'function') return;
    showNotice({
      title: 'My tracks is full',
      message: `You already have ${limits.max_files} saved tracks. "${name}" is playing now, but it wasn't saved. ` +
               'To save it, delete one of your saved tracks in My tracks, then upload it again.',
      actionLabel: 'Open My tracks',
      onAction: openMyTracks
    });
  }

  function render() {
    box.hidden = !limits.enabled;
    if (!limits.enabled) return;
    countEl.textContent = `${tracks.length} / ${limits.max_files}`;
    const limitsEl = document.getElementById('tracks-limits');
    if (limitsEl) {
      const mins = typeof MAX_TRACK_SECONDS === 'number' ? ` · ${MAX_TRACK_SECONDS / 60} min` : '';
      limitsEl.textContent = `Up to ${limits.max_files} tracks · ${mbText(limits.max_bytes)}${mins} each`;
    }
    listEl.innerHTML = '';
    if (!tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'cb-tracks__empty';
      empty.textContent = 'Tracks you upload are saved here.';
      listEl.appendChild(empty);
      return;
    }
    tracks.forEach(t => {
      const row = document.createElement('div');
      row.className = 'cb-track' + (t.id === activeId ? ' cb-track--active' : '');

      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'cb-track__use';
      use.title = `Use "${t.name}" as the backing track`;
      const name = document.createElement('span');
      name.className = 'cb-track__name';
      name.textContent = (t.id === activeId ? '▶ ' : '') + t.name;
      const size = document.createElement('span');
      size.className = 'cb-track__size';
      size.textContent = sizeText(t.size);
      use.append(name, size);
      use.addEventListener('click', () => useTrack(t));

      // Delete asks for a second click instead of a pop-up.
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cb-track__del';
      del.title = 'Delete this track';
      del.setAttribute('aria-label', `Delete ${t.name}`);
      del.textContent = '🗑';
      let armed = null;
      del.addEventListener('click', () => {
        if (!armed) {
          del.textContent = 'Delete?';
          del.classList.add('cb-track__del--armed');
          armed = setTimeout(() => {
            armed = null;
            del.textContent = '🗑';
            del.classList.remove('cb-track__del--armed');
          }, 3000);
          return;
        }
        clearTimeout(armed);
        deleteTrack(t, row);
      });

      row.append(use, del);
      listEl.appendChild(row);
    });
  }

  async function load() {
    if (!localStorage.getItem('cb_token')) return;
    try {
      const res = await fetch(`${BACKEND_URL}/audio`, { headers: authOnly() });
      if (!res.ok) throw new Error(await errorText(res, 'Could not load your saved tracks.'));
      const data = await res.json();
      limits = { enabled: !!data.enabled, max_files: data.max_files, max_bytes: data.max_bytes };
      tracks = Array.isArray(data.tracks) ? data.tracks : [];
      loaded = true;
      render();
    } catch (err) {
      // Leave the section as it was; try again next time the menu opens.
      console.warn('[tracks]', err.message);
    }
  }

  async function useTrack(t) {
    if (busy) return;
    busy = true;
    box.classList.add('cb-tracks--busy');
    showMsg(`Loading "${t.name}"…`);
    try {
      const res = await fetch(`${BACKEND_URL}/audio/${encodeURIComponent(t.id)}/file`, { headers: authOnly() });
      if (!res.ok) throw new Error(await errorText(res, 'Could not load the track.'));
      const ok = await useAudioTrack(await res.arrayBuffer(), t.name);
      if (ok) {
        activeId = t.id;
        const input = document.getElementById('audio-upload');
        if (input) input.value = '';
        showMsg('');
        render();
      } else {
        showMsg('That track could not be played in this browser.', 'error');
      }
    } catch (err) {
      showMsg(err.message, 'error');
    } finally {
      busy = false;
      box.classList.remove('cb-tracks--busy');
    }
  }

  async function deleteTrack(t, row) {
    row.classList.add('cb-track--removing');
    try {
      const res = await fetch(`${BACKEND_URL}/audio/${encodeURIComponent(t.id)}`, { method: 'DELETE', headers: authOnly() });
      if (!res.ok && res.status !== 404) throw new Error(await errorText(res, 'Could not delete the track.'));
      tracks = tracks.filter(x => x.id !== t.id);
      if (activeId === t.id) activeId = null;   // it keeps playing until removed or replaced
      showMsg('');
      render();
    } catch (err) {
      row.classList.remove('cb-track--removing');
      showMsg(err.message, 'error');
      render();
    }
  }

  // Called by app.js after a newly picked file decoded fine. The track is
  // already playing either way; this only decides whether it's saved.
  window.saveTrackToAccount = async function (file) {
    if (!localStorage.getItem('cb_token')) return;
    if (!loaded) await load();
    if (!limits.enabled) return;
    activeId = null;
    render();
    if (file.size > limits.max_bytes) {
      showMsg('');
      if (typeof showNotice === 'function') {
        showNotice({
          title: 'Track not saved',
          message: `"${file.name}" is ${mbText(file.size)}. It's playing now, but saved tracks can be up to ` +
                   `${mbText(limits.max_bytes)}, so it wasn't added to My tracks.`
        });
      }
      return;
    }
    if (tracks.length >= limits.max_files) {
      showMsg('');
      showFullNotice(file.name);
      return;
    }
    busy = true;
    box.classList.add('cb-tracks--busy');
    showMsg(`Saving "${file.name}" to My tracks…`);
    try {
      const res = await fetch(`${BACKEND_URL}/audio`, {
        method: 'POST',
        headers: {
          ...authOnly(),
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name)
        },
        body: file
      });
      if (res.status === 409) {
        // Filled up from another tab/device in the meantime.
        showMsg('');
        await load();
        showFullNotice(file.name);
        return;
      }
      if (!res.ok) throw new Error(await errorText(res, 'Could not save the track.'));
      const data = await res.json();
      tracks.unshift(data.track);
      activeId = data.track.id;
      showMsg('Saved to My tracks.', 'ok');
      render();
      setTimeout(() => { if (msgEl.textContent === 'Saved to My tracks.') showMsg(''); }, 4000);
    } catch (err) {
      showMsg(`Playing it now, but it wasn't saved: ${err.message}`, 'error');
    } finally {
      busy = false;
      box.classList.remove('cb-tracks--busy');
    }
  };

  // Called by app.js when the backing track is removed (✕).
  window.markActiveTrack = function (id) {
    activeId = id;
    render();
  };

  // Load once at start, and refresh whenever the menu is opened.
  load();
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      if (menuBtn.getAttribute('aria-expanded') === 'true' && !busy) load();
    });
  }
})();
