// ═══════════════════════════════════════════════
//  billing-ui.js — the account's plan on the main page (index.html)
//    • Sidebar: the plan (Free / Student Pro until … / Admin) and an
//      Upgrade or Plans button.
//    • Settings → Plan: the plan, today's analyses, auto-renew (with
//      Cancel) and the payment history.
//  Uses BACKEND_URL and cbToken from app.js. The plans and payments
//  themselves live on plans.html.
// ═══════════════════════════════════════════════
(function () {
  if (typeof BACKEND_URL === 'undefined' || !cbToken) return;
  const $ = (id) => document.getElementById(id);
  const headers = (json) => {
    const h = { Authorization: `Bearer ${cbToken}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  };
  const peso = (c) => '₱' + (Number(c || 0) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 });
  const day  = (d) => (d ? new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const esc  = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let plan = null;   // latest GET /billing/me

  function renderBadge() {
    const box = $('plan-badge');
    if (!box || !plan) return;
    const text = $('plan-badge-text'), btn = $('plan-badge-btn');
    if (plan.is_admin) {
      text.textContent = 'Admin · every Student Pro feature';
      btn.hidden = true;
    } else if (plan.plan.code === 'pro') {
      text.textContent = plan.auto_renew
        ? `Student Pro · renews ${day(plan.pro_until)}`
        : `Student Pro · until ${day(plan.pro_until)}`;
      btn.textContent = 'Plan';
      btn.classList.remove('cb-btn--primary');
      btn.classList.add('cb-btn--ghost');
      btn.hidden = false;
    } else {
      const left = Math.max(0, (plan.usage.daily_limit || 0) - plan.usage.analyses_today);
      text.textContent = `Free · ${left} of ${plan.usage.daily_limit} analyses left today`;
      btn.textContent = 'Upgrade';
      btn.hidden = false;
    }
    box.hidden = false;
  }

  async function refreshPlan() {
    try {
      const res = await fetch(`${BACKEND_URL}/billing/me`, { headers: headers() });
      if (!res.ok) return null;
      plan = await res.json();
      renderBadge();
      return plan;
    } catch (e) { return null; }
  }
  window.refreshPlan = refreshPlan;

  // ── Settings → Plan ─────────────────────────────
  const BILLING = { prepaid: 'Paid once', auto_renew: 'Auto-renew' };
  const STATUS  = { paid: 'Paid', pending: 'Not completed', failed: 'Failed', expired: 'Expired' };

  async function loadPlanPane() {
    const p = await refreshPlan();
    if (!p) {
      $('set-plan-detail').textContent = 'Could not load your plan. Please try again.';
      return;
    }
    const pro = p.plan.code === 'pro';
    $('set-plan-name').textContent = p.is_admin ? 'Admin' : p.plan.name;
    $('set-plan-detail').textContent = p.is_admin
      ? 'Admins have every Student Pro feature without a subscription.'
      : pro
        ? (p.source === 'admin_grant' ? `Given by an admin, until ${day(p.pro_until)}.` : `Active until ${day(p.pro_until)}.`)
        : 'Upgrade for the advanced analysis, the defect-risk score and more.';
    $('set-plan-btn').hidden = p.is_admin;
    $('set-plan-btn').textContent = pro ? 'Extend or change' : 'See plans';
    $('set-plan-usage').textContent = p.usage.daily_limit
      ? `Analyses today: ${p.usage.analyses_today} of ${p.usage.daily_limit}. The count resets at midnight.`
      : '';

    const renew = p.auto_renew;
    $('set-renew-group').hidden = !renew;
    if (renew) {
      $('set-renew-text').textContent = renew.status === 'past_due'
        ? `The last renewal payment failed. Xendit will try again; Student Pro stays on until ${day(renew.next_charge)}.`
        : `${peso(renew.amount_centavos)} every ${renew.duration_days >= 365 ? 'year' : 'month'}. Next charge: ${day(renew.next_charge)}.`;
    }

    const tbody = $('set-payments');
    try {
      const res = await fetch(`${BACKEND_URL}/billing/payments`, { headers: headers() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      tbody.innerHTML = data.payments.map((x) => `
        <tr>
          <td>${day(x.paid_at || x.created_at)}</td>
          <td>${esc(x.plan_name)}, ${BILLING[x.billing] || ''} ${x.duration_days >= 365 ? '1 year' : `${x.duration_days} days`}</td>
          <td>${peso(x.amount_centavos)}</td>
          <td><span class="cb-pay-status cb-pay-status--${esc(x.status)}">${STATUS[x.status] || esc(x.status)}</span></td>
        </tr>`).join('') || '<tr><td colspan="4" class="cb-set__muted">No payments yet.</td></tr>';
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="4" class="cb-set__muted">Could not load your payments.</td></tr>';
    }
  }
  window.loadPlanPane = loadPlanPane;

  const cancelBtn = $('set-renew-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      const msg = $('set-renew-msg');
      if (!window.confirm('Turn off auto-renew? Student Pro stays on until the end of the period you already paid for.')) return;
      cancelBtn.disabled = true;
      try {
        const res = await fetch(`${BACKEND_URL}/billing/cancel-renewal`, { method: 'POST', headers: headers(true) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        msg.textContent = data.message;
        msg.className = 'cb-bugreport-modal__msg cb-bugreport-modal__msg--success';
        if (window.toast) toast('Auto-renew is off.', 'success', { silent: true });
        await loadPlanPane();
      } catch (e) {
        msg.textContent = e.message || 'Could not cancel auto-renew. Please try again.';
        msg.className = 'cb-bugreport-modal__msg cb-bugreport-modal__msg--error';
        if (window.toast) toast('Could not turn off auto-renew.', 'error', { silent: true });
      } finally {
        msg.hidden = false;
        cancelBtn.disabled = false;
      }
    });
  }

  refreshPlan();
  // Keep "analyses left today" current after each analysis.
  document.getElementById('analyze-btn')?.addEventListener('click', () => setTimeout(refreshPlan, 4000));
})();
