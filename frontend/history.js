/* ═══════════════════════════════════════════════
   BUGBEAT — history.js
   View History panel — load, filter, restore
═══════════════════════════════════════════════ */

// ── State ──────────────────────────────────────
let historyData     = [];
let filteredHistory = [];
let activeHistoryId = null;
let historyFilter   = 'all';
let historyPage     = 1;
const PAGE_SIZE     = 10;

// ── DOM refs ───────────────────────────────────
const historyBtn        = document.getElementById('history-btn');
const historyPanel      = document.getElementById('history-panel');
const historyCloseBtn   = document.getElementById('history-close-btn');
const historyList       = document.getElementById('history-list');
const historyDetail     = document.getElementById('history-detail');
const historyEmpty      = document.getElementById('history-empty');
const historySearchInput= document.getElementById('history-search');
const historyCountBadge = document.getElementById('history-count');
const historyTotalStat  = document.getElementById('h-stat-total');
const historyHighStat   = document.getElementById('h-stat-high');
const historyCritStat   = document.getElementById('h-stat-crit');
const historyPageCtrl   = document.getElementById('history-page-ctrl');
const restoreSessionBtn = document.getElementById('restore-session-btn');

// ── Open / Close panel ─────────────────────────
if (historyBtn) {
  historyBtn.addEventListener('click', async () => {
    historyPanel.classList.add('cb-history--open');
    await loadHistory();
  });
}

if (historyCloseBtn) {
  historyCloseBtn.addEventListener('click', () => {
    historyPanel.classList.remove('cb-history--open');
  });
}

// Close on backdrop click
if (historyPanel) {
  historyPanel.addEventListener('click', (e) => {
    if (e.target === historyPanel) {
      historyPanel.classList.remove('cb-history--open');
    }
  });
}

// ── Load history from backend ──────────────────
async function loadHistory() {
  try {
    historyList.innerHTML = `<div class="cb-history-loading">Loading sessions…</div>`;
    const res  = await fetch(`${BACKEND_URL}/history`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load history');
    historyData = data.history || [];
    applyHistoryFilter();
  } catch (err) {
    historyList.innerHTML = `<div class="cb-history-error">⚠ ${err.message}</div>`;
  }
}

// ── Filter & search ────────────────────────────
if (historySearchInput) {
  historySearchInput.addEventListener('input', () => {
    historyPage = 1;
    applyHistoryFilter();
  });
}

function setHistoryFilter(filter, btn) {
  historyFilter = filter;
  historyPage   = 1;
  document.querySelectorAll('.cb-history-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyHistoryFilter();
}

function applyHistoryFilter() {
  const q = (historySearchInput?.value || '').toLowerCase().trim();
  filteredHistory = historyData.filter(s => {
    const matchFilter =
      historyFilter === 'all' ||
      s.risk_level?.toLowerCase() === historyFilter;
    const matchSearch =
      !q ||
      s.language?.toLowerCase().includes(q) ||
      s.risk_level?.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  // Update stats
  if (historyTotalStat) historyTotalStat.textContent = filteredHistory.length;
  if (historyHighStat)  historyHighStat.textContent  = filteredHistory.filter(s => s.risk_level?.toLowerCase() === 'high').length;
  if (historyCritStat)  historyCritStat.textContent  = filteredHistory.filter(s => s.risk_level?.toLowerCase() === 'critical' || s.risk_level?.toLowerCase() === 'very high').length;

  renderHistoryList();
  renderPagination();
}

// ── Render session list ────────────────────────
function renderHistoryList() {
  const start   = (historyPage - 1) * PAGE_SIZE;
  const end     = start + PAGE_SIZE;
  const visible = filteredHistory.slice(start, end);

  if (historyCountBadge) historyCountBadge.textContent = filteredHistory.length + ' sessions';

  if (!visible.length) {
    historyList.innerHTML = `
      <div class="cb-empty-state" style="padding:2rem">
        <span class="cb-empty-state__icon">◈</span>
        <span>No sessions found</span>
      </div>`;
    return;
  }

  historyList.innerHTML = visible.map(s => {
    const score     = parseFloat(s.fusion_score || 0);
    const riskLower = (s.risk_level || 'low').toLowerCase().replace(' ', '-');
    const langClass = getLangClass(s.language);
    const total     = (s.warning_count || 0) + (s.error_count || 0) + (s.critical_count || 0);
    return `
      <div class="cb-history-card ${s.id === activeHistoryId ? 'active' : ''}"
           data-id="${s.id}" onclick="selectHistorySession(${s.id})">
        <div class="cb-history-card__top">
          <span class="cb-lang-badge cb-lang-badge--${langClass}">${s.language || 'Unknown'}</span>
          <span class="cb-history-card__time">${formatHistoryDate(s.created_at)}</span>
        </div>
        <div class="cb-history-card__risk-row">
          <span class="cb-history-card__risk-label" style="color:${riskColor(riskLower)}">${s.risk_level || 'Low'}</span>
          <div class="cb-history-card__risk-bar">
            <div class="cb-history-card__risk-fill" style="width:${Math.round(score * 100)}%;background:${riskColor(riskLower)}"></div>
          </div>
          <span class="cb-history-card__score" style="color:${riskColor(riskLower)}">${score.toFixed(2)}</span>
        </div>
        <div class="cb-history-card__stats">
          <div class="cb-history-stat"><span class="cb-history-stat__l">Lines</span><span class="cb-history-stat__v" style="color:#888">${s.total_lines || 0}</span></div>
          <div class="cb-history-stat"><span class="cb-history-stat__l">Clean</span><span class="cb-history-stat__v" style="color:var(--clean)">${s.clean_count || 0}</span></div>
          <div class="cb-history-stat"><span class="cb-history-stat__l">Warn</span><span class="cb-history-stat__v" style="color:var(--warning)">${s.warning_count || 0}</span></div>
          <div class="cb-history-stat"><span class="cb-history-stat__l">Err</span><span class="cb-history-stat__v" style="color:var(--error)">${(s.error_count || 0) + (s.critical_count || 0)}</span></div>
        </div>
      </div>`;
  }).join('');
}

// ── Select a session ───────────────────────────
async function selectHistorySession(id) {
  activeHistoryId = id;
  renderHistoryList();

  // Show loading in detail panel
  historyEmpty.hidden  = true;
  historyDetail.hidden = false;
  document.getElementById('h-detail-title').textContent = 'Loading…';
  document.getElementById('h-issues-list').innerHTML     = '<div class="cb-history-loading">Loading issues…</div>';
  document.getElementById('h-code-block').innerHTML      = '';

  try {
    const res  = await fetch(`${BACKEND_URL}/history/${id}`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load session');
    renderHistoryDetail(data);
  } catch (err) {
    document.getElementById('h-detail-title').textContent = `⚠ ${err.message}`;
  }
}

// ── Render detail panel ────────────────────────
function renderHistoryDetail(data) {
  const analysis  = data.analysis  || {};
  const issues    = data.issues    || [];
  const beatGrid  = data.beat_grid || [];
  const snapshot = { submitted_code: data.code || '' };
  const score     = parseFloat(analysis.fusion_score || 0);
  const riskLower = (analysis.risk_level || 'low').toLowerCase().replace(' ', '-');

  document.getElementById('h-detail-title').textContent =
    `${analysis.language || 'Unknown'} — ${formatHistoryDate(analysis.created_at)}`;

  document.getElementById('h-meta-lang').textContent   = analysis.language  || '—';
  document.getElementById('h-meta-lines').textContent  = analysis.total_lines || '—';
  document.getElementById('h-meta-issues').textContent = analysis.issues_found || '—';
  document.getElementById('h-meta-issues').style.color = riskColor(riskLower);
  document.getElementById('h-meta-risk').textContent   = analysis.risk_level  || '—';
  document.getElementById('h-meta-risk').style.color   = riskColor(riskLower);
  document.getElementById('h-fusion-score').textContent = score.toFixed(2);
  document.getElementById('h-fusion-score').style.color = riskColor(riskLower);
  document.getElementById('h-fusion-fill').style.width  = `${Math.round(score * 100)}%`;

  // Issues list
  const issueEl = document.getElementById('h-issues-list');
  if (!issues.length) {
    issueEl.innerHTML = '<div class="cb-empty-state" style="padding:1rem"><span>No issues recorded</span></div>';
  } else {
    issueEl.innerHTML = issues.map(iss => `
      <div class="cb-history-issue">
        <div class="cb-history-issue__dot" style="background:${sevColor(iss.severity)}"></div>
        <span class="cb-history-issue__line">Ln ${iss.line_number}</span>
        <span class="cb-history-issue__desc">${iss.description || iss.code_snippet || ''}</span>
      </div>`).join('');
  }

  // Code snapshot
  const codeEl = document.getElementById('h-code-block');
  codeEl.textContent = snapshot.submitted_code
    ? snapshot.submitted_code.slice(0, 600) + (snapshot.submitted_code.length > 600 ? '\n…' : '')
    : 'No code snapshot saved.';

  // Store data for restore
  restoreSessionBtn.dataset.analysisId = analysis.id;
  restoreSessionBtn._data = { analysis, issues, beatGrid, snapshot };
}

// ── Restore session ────────────────────────────
if (restoreSessionBtn) {
  restoreSessionBtn.addEventListener('click', () => {
    const d = restoreSessionBtn._data;
    if (!d) return;
    doRestoreSession(d);
  });
}

function doRestoreSession(d) {
  const { analysis, issues, beatGrid, snapshot } = d;

  // 1. Restore code in Monaco Editor
  if (snapshot?.submitted_code && typeof setCode === 'function') {
    setCode(snapshot.submitted_code, analysis.language?.toLowerCase() || 'javascript');
  }

  // 2. Restore beat grid
  if (beatGrid?.length && typeof renderSequencer === 'function') {
    const beats = beatGrid.map(b => ({
      line:     b.line_number,
      severity: b.severity,
      message:  ''
    }));
    beatData = beats;
    renderSequencer(beats);
  }

  // 3. Restore issues panel
  if (typeof renderIssues === 'function') {
    const issuesMapped = issues.map(i => ({
      line:     i.line_number,
      severity: i.severity,
      message:  i.description || i.code_snippet || ''
    }));
    renderIssues(issuesMapped.filter(i => i.severity !== 'clean'));
  }

  // 4. Restore stats
  if (typeof updateStats === 'function') {
    const allLines = beatGrid.map(b => ({ severity: b.severity }));
    updateStats(allLines);
  }

  // 5. Restore Monaco decorations
  if (typeof highlightEditorLines === 'function' && beatGrid?.length) {
    highlightEditorLines(beatGrid.map(b => ({ line: b.line_number, severity: b.severity })));
  }

  // 6. Update line count
  const lc = document.getElementById('line-count');
  if (lc) lc.textContent = `${analysis.total_lines || 0} lines`;

  // 7. Close history panel
  historyPanel.classList.remove('cb-history--open');

  // 8. Enable play button
  const pb = document.getElementById('play-btn');
  const sb = document.getElementById('stop-btn');
  if (pb) pb.disabled = false;
  if (sb) sb.disabled = false;

  // 9. Show success feedback
  if (typeof setMusicStatus === 'function') {
    setMusicStatus(`✅ Session restored — ${analysis.language} · ${analysis.risk_level} risk`, 'ok');
  }
}

// ── Pagination ─────────────────────────────────
function renderPagination() {
  if (!historyPageCtrl) return;
  const totalPages = Math.ceil(filteredHistory.length / PAGE_SIZE);
  if (totalPages <= 1) { historyPageCtrl.innerHTML = ''; return; }

  let html = `<button class="cb-pg-btn" onclick="goHistoryPage(${historyPage - 1})" ${historyPage === 1 ? 'disabled' : ''}>‹</button>`;
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="cb-pg-btn ${i === historyPage ? 'active' : ''}" onclick="goHistoryPage(${i})">${i}</button>`;
  }
  html += `<button class="cb-pg-btn" onclick="goHistoryPage(${historyPage + 1})" ${historyPage === totalPages ? 'disabled' : ''}>›</button>`;
  historyPageCtrl.innerHTML = html;
}

function goHistoryPage(page) {
  const totalPages = Math.ceil(filteredHistory.length / PAGE_SIZE);
  if (page < 1 || page > totalPages) return;
  historyPage = page;
  renderHistoryList();
  renderPagination();
  historyList.scrollTop = 0;
}

// ── Helpers ────────────────────────────────────
function riskColor(risk) {
  const map = {
    'low':       '#1de4a8',
    'medium':    '#d9921e',
    'high':      '#d45a30',
    'critical':  '#d43c3c',
    'very-high': '#d43c3c',
    'very high': '#d43c3c'
  };
  return map[risk?.toLowerCase()] || '#6b7180';
}

function sevColor(sev) {
  const map = { clean: '#3b9e5e', warning: '#d9921e', error: '#d45a30', critical: '#d43c3c' };
  return map[sev] || '#6b7180';
}

function getLangClass(lang) {
  const map = {
    python: 'py', javascript: 'js', typescript: 'ts',
    java: 'java', 'c++': 'cpp', cpp: 'cpp',
    rust: 'rust', go: 'go', php: 'php'
  };
  return map[(lang || '').toLowerCase()] || 'default';
}

function formatHistoryDate(dateStr) {
  if (!dateStr) return '—';
  const d    = new Date(dateStr);
  const now  = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hrs  = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1)   return 'Just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hrs  < 24)  return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (days === 1) return `Yesterday, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}