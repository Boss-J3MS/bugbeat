// ═══════════════════════════════════════════════
//  plans.js — the Plans page (plans.html)
//  Shows Free and Student Pro from GET /plans and lets a logged-in user buy
//  Student Pro through PayMongo:
//    • Pay once:   POST /billing/checkout → PayMongo's checkout page.
//    • Auto-renew: the card goes straight to PayMongo (public key), then
//                  POST /billing/subscribe → 3-D Secure page if needed.
//  Either way the user comes back to payment-result.html.
// ═══════════════════════════════════════════════
(function () {
  const BACKEND_URL =
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'http://localhost:3000'
      : 'https://bugbeat.onrender.com';
  const token = localStorage.getItem('cb_token');
  const $ = (id) => document.getElementById(id);
  const peso = (c) => '₱' + (Number(c || 0) / 100).toLocaleString('en-PH', { maximumFractionDigits: 2 });
  const day  = (d) => new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
  const period = (days) => (days >= 365 ? '1 year' : `${days} days`);

  let info = null;              // GET /plans
  let me = null;                // GET /billing/me (logged in)
  let billing = 'prepaid';
  let priceId = null;

  if (token) {
    $('pl-back').href = 'index.html';
    $('pl-back').textContent = '← Back to BugBeat';
    $('pl-home').href = 'index.html';
  }

  function featureList(p) {
    const items = [
      `${p.daily_analyses} analyses a day${p.code === 'pro' ? ' (fair use)' : ''}`,
      p.advanced_analysis ? 'Advanced analysis: finds more bugs, fewer false alarms' : 'Standard analysis',
      p.risk_score ? 'Defect-risk score for your code' : 'Line-by-line issues, music and sound feedback',
      `Run code: ${p.runs_per_15min} runs per 15 minutes`,
      `${p.track_limit} saved music track${p.track_limit === 1 ? '' : 's'}`,
      p.history_limit ? `History: your latest ${p.history_limit} sessions` : 'History: all your sessions',
    ];
    return items.map((t) => `<li>${t}</li>`).join('');
  }

  function showMsg(text, ok) {
    const el = $('pl-msg');
    el.textContent = text;
    el.className = 'pl-msg ' + (ok ? 'pl-msg--ok' : 'pl-msg--error');
    el.hidden = !text;
  }

  function pricesFor(b) {
    return (info?.prices || []).filter((p) => p.billing === b && p.plan_code === 'pro');
  }

  function renderOptions() {
    const list = pricesFor(billing);
    if (!list.some((p) => p.id === priceId)) priceId = list[0]?.id ?? null;
    $('pl-options').innerHTML = list.map((p) => `
      <button type="button" class="pl-option${p.id === priceId ? ' is-active' : ''}" role="radio"
              aria-checked="${p.id === priceId}" data-id="${p.id}">
        <span class="pl-option__len">${billing === 'auto_renew' ? (p.duration_days >= 365 ? 'Yearly' : 'Monthly') : period(p.duration_days)}</span>
        <span class="pl-option__amt">${peso(p.amount_centavos)}${billing === 'auto_renew' ? (p.duration_days >= 365 ? ' / year' : ' / month') : ''}</span>
      </button>`).join('') || '<p class="pl-note">No prices are available right now.</p>';
    const sel = list.find((p) => p.id === priceId);
    if (sel) {
      $('pl-pro-amount').textContent = peso(sel.amount_centavos);
      $('pl-pro-per').textContent = billing === 'auto_renew'
        ? (sel.duration_days >= 365 ? 'per year, renews automatically' : 'per month, renews automatically')
        : `for ${period(sel.duration_days)}`;
    }
    $('pl-card-form').hidden = billing !== 'auto_renew';
    $('pl-billing-help').textContent = billing === 'auto_renew'
      ? 'Your card is charged now and again every period until you turn auto-renew off. Cards only.'
      : 'One payment, nothing charged later. Pay with a card, QR Ph (GCash, Maya and banking apps) or other methods PayMongo offers.';
    $('pl-pay').textContent = billing === 'auto_renew' ? 'Start auto-renew' : 'Continue to payment';
    $('pl-pay').disabled = !sel;
  }

  function renderCurrent() {
    const box = $('pl-current');
    if (!me) { box.hidden = true; return; }
    let text;
    if (me.is_admin) text = 'You are an admin: you already have every Student Pro feature.';
    else if (me.plan.code === 'pro') {
      text = me.auto_renew
        ? `You're on Student Pro. It renews on ${day(me.auto_renew.next_charge)}.`
        : `You're on Student Pro until ${day(me.pro_until)}. Buying more adds to the time you have.`;
    } else {
      text = `You're on Free: ${me.usage.analyses_today} of ${me.usage.daily_limit} analyses used today.`;
    }
    box.textContent = text;
    box.hidden = false;
  }

  function renderBuy() {
    const foot = $('pl-pro-foot');
    $('pl-buy').hidden = true;
    foot.innerHTML = '';
    if (!info) return;
    if (!info.buying_enabled) {
      foot.innerHTML = '<span class="pl-note">Buying Student Pro is not available right now.</span>';
      return;
    }
    if (!token) {
      foot.innerHTML = '<button type="button" id="pl-login" class="cb-btn cb-btn--primary pl-pay">Log in to upgrade</button>';
      $('pl-login').addEventListener('click', () => {
        try { sessionStorage.setItem('cb_after_login', 'plans.html'); } catch (e) {}
        location.href = 'login.html';
      });
      return;
    }
    if (me?.is_admin) {
      foot.innerHTML = '<span class="pl-note">Admins already have every Student Pro feature.</span>';
      return;
    }
    $('pl-billing').querySelector('[data-billing="auto_renew"]').hidden = !info.auto_renew_enabled || !info.public_key;
    if (me?.auto_renew) $('pl-billing').querySelector('[data-billing="auto_renew"]').hidden = true;
    $('pl-buy').hidden = false;
    renderOptions();
  }

  async function load() {
    try {
      const res = await fetch(`${BACKEND_URL}/plans`);
      info = await res.json();
      if (!res.ok) throw new Error(info.error);
      const [free, pro] = info.plans;
      $('pl-free-list').innerHTML = featureList(free);
      $('pl-pro-list').innerHTML = featureList(pro);
      $('pl-test').hidden = !info.test_mode;
    } catch (e) {
      $('pl-pro-foot').innerHTML = '<span class="pl-note">Could not load the plans. Please refresh the page.</span>';
      return;
    }
    if (token) {
      try {
        const res = await fetch(`${BACKEND_URL}/billing/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) { localStorage.removeItem('cb_token'); location.reload(); return; }
        if (res.ok) me = await res.json();
      } catch (e) {}
    }
    renderCurrent();
    renderBuy();
  }

  $('pl-billing').addEventListener('click', (e) => {
    const btn = e.target.closest('.pl-seg__btn');
    if (!btn || btn.hidden) return;
    billing = btn.dataset.billing;
    $('pl-billing').querySelectorAll('.pl-seg__btn').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    showMsg('');
    renderOptions();
  });

  $('pl-options').addEventListener('click', (e) => {
    const btn = e.target.closest('.pl-option');
    if (!btn) return;
    priceId = Number(btn.dataset.id);
    renderOptions();
  });

  // A new attempt clears the last error.
  $('pl-card-form').addEventListener('input', () => showMsg(''));

  // Card number in groups of 4, expiry as MM/YY.
  $('pl-cc-number').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 19);
    e.target.value = d.replace(/(.{4})/g, '$1 ').trim();
  });
  $('pl-cc-exp').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  });

  async function api(path, body) {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server returned an error (${res.status}).`);
    return data;
  }

  // Sends the card to PayMongo with the public key; returns the payment method id.
  async function createCardMethod() {
    const number = $('pl-cc-number').value.replace(/\D/g, '');
    const [mm, yy] = $('pl-cc-exp').value.split('/');
    const cvc = $('pl-cc-cvc').value.replace(/\D/g, '');
    const name = $('pl-cc-name').value.trim();
    if (number.length < 13) throw new Error('Enter the card number.');
    if (!(Number(mm) >= 1 && Number(mm) <= 12) || !/^\d{2}$/.test(yy || '')) throw new Error('Enter the expiry date as MM/YY.');
    if (cvc.length < 3) throw new Error('Enter the 3- or 4-digit CVC.');
    if (!name) throw new Error('Enter the name on the card.');
    const res = await fetch('https://api.paymongo.com/v1/payment_methods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${info.public_key}:`) },
      body: JSON.stringify({ data: { attributes: {
        type: 'card',
        details: { card_number: number, exp_month: Number(mm), exp_year: 2000 + Number(yy), cvc },
        billing: { name },
      } } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.errors?.map((x) => x.detail).join(' ') || 'PayMongo did not accept the card details.');
    return data.data.id;
  }

  $('pl-pay').addEventListener('click', async () => {
    const btn = $('pl-pay');
    showMsg('');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Please wait…';
    try {
      if (billing === 'prepaid') {
        const data = await api('/billing/checkout', { price_id: priceId });
        location.href = data.checkout_url;           // PayMongo's checkout page
        return;
      }
      const pm = await createCardMethod();
      const data = await api('/billing/subscribe', { price_id: priceId, payment_method_id: pm });
      if (data.redirect_url) { location.href = data.redirect_url; return; }   // 3-D Secure
      location.href = `payment-result.html?subscription=${data.subscription_id}`;
    } catch (e) {
      showMsg(e.message === 'Failed to fetch' ? 'Could not reach the server. Please try again.' : e.message, false);
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  load();
})();
