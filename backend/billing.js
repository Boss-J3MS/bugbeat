// ═══════════════════════════════════════════════
//  BUGBEAT — billing.js
//  Plans (Free / Student Pro), limits, and payments through PayMongo.
//
//  Two ways to pay for Student Pro:
//    • prepaid     — one payment through PayMongo Checkout buys 30 or 365
//                    days (cards, QR Ph and other methods PayMongo offers).
//    • auto_renew  — a PayMongo subscription charges a saved card every
//                    month or year until it is cancelled.
//  Only PayMongo's webhook (POST /webhooks/paymongo) marks a payment as
//  paid and turns Pro on. Admins always have Pro features and can give
//  Pro to an account for a number of days (admin_grant).
//
//  Settings (Render → Environment, and backend/.env locally):
//    PAYMONGO_SECRET_KEY      sk_test_… (test mode) — server only
//    PAYMONGO_PUBLIC_KEY      pk_test_… — sent to the browser for card entry
//    PAYMONGO_WEBHOOK_SECRET  the webhook's secret key (from PayMongo)
//    PAYMONGO_AUTO_RENEW      'off' hides the auto-renew option
//    PAYMONGO_METHODS         payment methods offered at Checkout,
//                             comma-separated (default card,qrph,gcash,paymaya)
//  Without PAYMONGO_SECRET_KEY, buying is switched off but the plans and
//  limits still work.
// ═══════════════════════════════════════════════

import crypto from 'crypto';
import db from './db.js';
import { requireAuth, requireAdmin, verifyToken } from './auth.js';

const PAYMONGO_API    = 'https://api.paymongo.com';
const SECRET_KEY      = process.env.PAYMONGO_SECRET_KEY || '';
const PUBLIC_KEY      = process.env.PAYMONGO_PUBLIC_KEY || '';
const WEBHOOK_SECRET  = process.env.PAYMONGO_WEBHOOK_SECRET || '';
const AUTO_RENEW_ON   = process.env.PAYMONGO_AUTO_RENEW !== 'off';
const CHECKOUT_METHODS = (process.env.PAYMONGO_METHODS || 'card,qrph,gcash,paymaya')
  .split(',').map(s => s.trim()).filter(Boolean);
const FRONTEND_URL    = (process.env.FRONTEND_URL || 'http://localhost:5500').replace(/\/+$/, '');

export const billingEnabled = SECRET_KEY.length > 0;
const testMode = !SECRET_KEY || SECRET_KEY.startsWith('sk_test_');
if (!billingEnabled) console.warn('[billing] PAYMONGO_SECRET_KEY not set — buying Student Pro is switched off.');

// Used when the plans tables haven't been created yet (migrations/billing.sql),
// so Analyze and the rest keep working with the Free limits.
const DEFAULT_PLANS = {
  free: { id: null, code: 'free', name: 'Free', daily_analyses: 15, runs_per_15min: 15,
          track_limit: 1, history_limit: 20, advanced_analysis: 0, risk_score: 0 },
  pro:  { id: null, code: 'pro', name: 'Student Pro', daily_analyses: 200, runs_per_15min: 40,
          track_limit: 5, history_limit: null, advanced_analysis: 1, risk_score: 1 },
};

// ── Plans (cached for a minute) ────────────────
let plansCache = null, plansCachedAt = 0, tablesReady = true;
async function loadPlans() {
  if (plansCache && Date.now() - plansCachedAt < 60_000) return plansCache;
  try {
    const [rows] = await db.query('SELECT * FROM plans');
    const byCode = { ...DEFAULT_PLANS };
    for (const r of rows) byCode[r.code] = r;
    plansCache = byCode; plansCachedAt = Date.now(); tablesReady = true;
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    if (tablesReady) console.warn('[billing] plans tables missing — run backend/migrations/billing.sql. Using the default limits.');
    tablesReady = false;
    plansCache = DEFAULT_PLANS; plansCachedAt = Date.now();
  }
  return plansCache;
}

function publicPlan(p) {
  return {
    code: p.code, name: p.name,
    daily_analyses: p.daily_analyses, runs_per_15min: p.runs_per_15min,
    track_limit: p.track_limit, history_limit: p.history_limit,
    advanced_analysis: !!p.advanced_analysis, risk_score: !!p.risk_score,
  };
}

// The Pro period that is running right now for a user, if any.
async function currentSubscription(userId) {
  if (!tablesReady) return null;
  try {
    const [rows] = await db.query(
      `SELECT * FROM subscriptions
        WHERE user_id = ? AND starts_at <= NOW() AND ends_at > NOW() AND status <> 'pending'
        ORDER BY ends_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return null;
    throw err;
  }
}

// The plan in effect for a request's user (null = logged out).
// Admins always get Pro features.
export async function planFor(user) {
  const plans = await loadPlans();
  if (!user) return { plan: plans.free, isAdmin: false, subscription: null };
  if (user.role === 'admin') return { plan: plans.pro, isAdmin: true, subscription: null };
  const sub = await currentSubscription(user.userId);
  return { plan: sub ? plans.pro : plans.free, isAdmin: false, subscription: sub };
}

// For routes that work with or without login (Analyze): the logged-in
// user if the request carries a valid, unexpired session, else null.
export async function optionalUser(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  try {
    const decoded = verifyToken(token);
    const [rows] = await db.query('SELECT id FROM sessions WHERE token = ? AND expires_at > NOW() LIMIT 1', [token]);
    return rows.length ? decoded : null;
  } catch { return null; }
}

// ── Daily analysis limit ───────────────────────
// Today's date in the Philippines (UTC+8), so counts reset at local midnight.
function phDate() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}
const hashIp = ip => crypto.createHash('sha256').update(`bugbeat:${ip}`).digest('hex');

async function usedToday(user, ip) {
  if (!tablesReady) return 0;
  const [rows] = user
    ? await db.query('SELECT analyses FROM usage_counts WHERE user_id = ? AND usage_date = ?', [user.userId, phDate()])
    : await db.query('SELECT analyses FROM usage_counts WHERE ip_hash = ? AND usage_date = ?', [hashIp(ip), phDate()]);
  return rows[0]?.analyses || 0;
}

// Checks the limit before an analysis. Returns { allowed, plan, isAdmin,
// used, limit }. Admins have no limit.
export async function checkAnalysisLimit(user, ip) {
  const { plan, isAdmin } = await planFor(user);
  let used = 0;
  try { used = await usedToday(user, ip); } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') console.warn('[billing] usage check failed:', err.message);
  }
  const limit = plan.daily_analyses;
  return { allowed: isAdmin || used < limit, plan, isAdmin, used, limit };
}

// Adds one to today's count after a successful analysis.
export async function countAnalysis(user, ip) {
  if (!tablesReady) return;
  try {
    if (user) {
      await db.query(
        `INSERT INTO usage_counts (user_id, usage_date, analyses) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE analyses = analyses + 1`, [user.userId, phDate()]);
    } else {
      await db.query(
        `INSERT INTO usage_counts (ip_hash, usage_date, analyses) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE analyses = analyses + 1`, [hashIp(ip), phDate()]);
    }
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') console.warn('[billing] usage count failed:', err.message);
  }
}

// ── PayMongo API ───────────────────────────────
class PayMongoError extends Error {
  constructor(status, body) {
    const detail = body?.errors?.map(e => e.detail).filter(Boolean).join(' ') || `PayMongo responded ${status}`;
    super(detail);
    this.status = status;
    this.body = body;
  }
}

async function paymongo(method, path, attributes) {
  const res = await fetch(`${PAYMONGO_API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${SECRET_KEY}:`).toString('base64'),
    },
    body: attributes === undefined ? undefined : JSON.stringify({ data: { attributes } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayMongoError(res.status, body);
  return body.data;
}

// ── Webhook signature ──────────────────────────
// Paymongo-Signature: t=<timestamp>,te=<test signature>,li=<live signature>
// signature = HMAC-SHA256(webhook secret, `${t}.${raw body}`)
export function verifyPaymongoSignature(header, rawBody, secret = WEBHOOK_SECRET) {
  if (!header || !rawBody || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map(p => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const given = parts.li || parts.te;
  if (!parts.t || !given) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Helpers ────────────────────────────────────
async function priceById(id) {
  const [rows] = await db.query(
    `SELECT pp.*, p.code AS plan_code, p.name AS plan_name
       FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id WHERE pp.id = ?`, [id]);
  return rows[0] || null;
}

// When a new period starts: now, or when the user's current Pro ends if a
// renewal is bought early (so no paid days are lost).
async function nextStart(conn, userId) {
  const [[row]] = await conn.query(
    `SELECT MAX(ends_at) AS last_end FROM subscriptions
      WHERE user_id = ? AND status <> 'pending' AND ends_at > NOW()`, [userId]);
  return row.last_end ? new Date(row.last_end) : new Date();
}
const addDays = (d, days) => new Date(d.getTime() + days * 86400e3);

const periodLabel = days => (days >= 365 ? '1 year' : `${days} days`);
const peso = c => `₱${(c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

// ── Webhook handlers ───────────────────────────
// Prepaid: Checkout paid → a Pro period of duration_days.
async function onCheckoutPaid(session, livemode) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[pay]] = await conn.query(
      `SELECT pm.*, pp.duration_days, pp.plan_id FROM payments pm
         JOIN plan_prices pp ON pp.id = pm.price_id
        WHERE pm.checkout_session_id = ? FOR UPDATE`, [session.id]);
    if (!pay || pay.status === 'paid') { await conn.commit(); return; }
    const start = await nextStart(conn, pay.user_id);
    const end = addDays(start, pay.duration_days);
    const [sub] = await conn.query(
      `INSERT INTO subscriptions (user_id, plan_id, price_id, source, status, starts_at, ends_at)
       VALUES (?, ?, ?, 'prepaid', 'active', ?, ?)`,
      [pay.user_id, pay.plan_id, pay.price_id, start, end]);
    await conn.query(
      `UPDATE payments SET status = 'paid', paid_at = NOW(), subscription_id = ?, livemode = ? WHERE id = ?`,
      [sub.insertId, livemode ? 1 : 0, pay.id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}

// Auto-renew: the first payment went through → Pro starts.
async function activateSubscription(conn, sub) {
  if (sub.ends_at) return false;                    // already active
  const start = await nextStart(conn, sub.user_id);
  await conn.query(
    `UPDATE subscriptions SET status = 'active', starts_at = ?, ends_at = ? WHERE id = ?`,
    [start, addDays(start, sub.duration_days), sub.id]);
  return true;
}

async function lockSubscription(conn, paymongoSubId) {
  const [[sub]] = await conn.query(
    `SELECT s.*, pp.duration_days FROM subscriptions s
       JOIN plan_prices pp ON pp.id = s.price_id
      WHERE s.paymongo_subscription_id = ? FOR UPDATE`, [paymongoSubId]);
  return sub || null;
}

async function onSubscriptionActivated(resource, livemode) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const sub = await lockSubscription(conn, resource.id);
    if (sub) {
      await activateSubscription(conn, sub);
      await conn.query(
        `UPDATE payments SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), livemode = ?
          WHERE subscription_id = ? AND invoice_id IS NULL AND status = 'pending'`,
        [livemode ? 1 : 0, sub.id]);
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}

// An invoice was paid: the first one starts Pro, later ones add a period.
async function onInvoicePaid(invoice, livemode) {
  const subId = invoice.attributes?.resource_id || invoice.attributes?.subscription_id;
  if (!subId) return;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const sub = await lockSubscription(conn, subId);
    if (!sub) { await conn.commit(); return; }
    const [[seen]] = await conn.query('SELECT id FROM payments WHERE invoice_id = ?', [invoice.id]);
    if (seen) { await conn.commit(); return; }
    // The first payment row (made at sign-up) has no invoice yet.
    const [[first]] = await conn.query(
      `SELECT id FROM payments WHERE subscription_id = ? AND invoice_id IS NULL ORDER BY id LIMIT 1 FOR UPDATE`, [sub.id]);
    if (first) {
      await activateSubscription(conn, sub);
      await conn.query(
        `UPDATE payments SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), invoice_id = ?, livemode = ? WHERE id = ?`,
        [invoice.id, livemode ? 1 : 0, first.id]);
    } else {
      // A renewal: one more period from the later of now or the current end.
      const from = sub.ends_at && new Date(sub.ends_at) > new Date() ? new Date(sub.ends_at) : new Date();
      await conn.query(
        `UPDATE subscriptions SET status = 'active', ends_at = ? WHERE id = ?`,
        [addDays(from, sub.duration_days), sub.id]);
      await conn.query(
        `INSERT INTO payments (user_id, price_id, subscription_id, invoice_id, amount_centavos, status, livemode, paid_at)
         VALUES (?, ?, ?, ?, ?, 'paid', ?, NOW())`,
        [sub.user_id, sub.price_id, sub.id, invoice.id,
         Number(invoice.attributes?.amount) || 0, livemode ? 1 : 0]);
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}

async function onSubscriptionStatus(resource, status) {
  const s = String(status || '').toLowerCase();
  if (s === 'past_due' || s === 'unpaid') {
    // Pro still runs to the end of the paid period; no more renewals for unpaid.
    await db.query(
      `UPDATE subscriptions SET status = 'past_due', auto_renew = IF(? = 'unpaid', 0, auto_renew)
        WHERE paymongo_subscription_id = ?`, [s, resource.id]);
  } else if (s === 'cancelled' || s === 'incomplete_cancelled') {
    await db.query(
      `UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, cancelled_at = COALESCE(cancelled_at, NOW())
        WHERE paymongo_subscription_id = ?`, [resource.id]);
  }
}

// ── Routes ─────────────────────────────────────
// opts.clientIp: the server's function for a request's real IP address.
export function registerBillingRoutes(app, { clientIp, errorRef }) {
  const fail = (res, where, err, message) => {
    console.error(`${where} error:`, err.message);
    res.status(err instanceof PayMongoError ? 502 : 500)
       .json({ error: message, ref: errorRef(err) });
  };

  // GET /plans — plans, limits and prices (Plans page).
  app.get('/plans', async (req, res) => {
    try {
      const plans = await loadPlans();
      let prices = [];
      if (tablesReady) {
        const [rows] = await db.query(
          `SELECT pp.id, pp.billing, pp.duration_days, pp.amount_centavos, p.code AS plan_code
             FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
            WHERE pp.is_active = 1 ORDER BY pp.billing, pp.duration_days`);
        prices = rows.filter(r => r.billing === 'prepaid' || AUTO_RENEW_ON);
      }
      res.json({
        plans: [publicPlan(plans.free), publicPlan(plans.pro)],
        prices,
        buying_enabled: billingEnabled && tablesReady,
        auto_renew_enabled: billingEnabled && tablesReady && AUTO_RENEW_ON,
        test_mode: testMode,
        public_key: PUBLIC_KEY || null,
      });
    } catch (err) { fail(res, 'GET /plans', err, 'Could not load the plans.'); }
  });

  // GET /billing/me — the user's plan, period and today's usage.
  app.get('/billing/me', requireAuth, async (req, res) => {
    try {
      const { plan, isAdmin, subscription } = await planFor(req.user);
      const used = await usedToday(req.user, clientIp(req)).catch(() => 0);
      let renewing = null;
      if (tablesReady) {
        const [rows] = await db.query(
          `SELECT s.id, s.status, s.ends_at, pp.duration_days, pp.amount_centavos
             FROM subscriptions s JOIN plan_prices pp ON pp.id = s.price_id
            WHERE s.user_id = ? AND s.source = 'auto_renew' AND s.auto_renew = 1
              AND s.status IN ('active','past_due') ORDER BY s.id DESC LIMIT 1`, [req.user.userId]);
        renewing = rows[0] || null;
      }
      res.json({
        plan: publicPlan(plan),
        is_admin: isAdmin,
        pro_until: subscription?.ends_at || null,
        source: subscription?.source || null,
        auto_renew: renewing ? {
          status: renewing.status, next_charge: renewing.ends_at,
          duration_days: renewing.duration_days, amount_centavos: renewing.amount_centavos,
        } : null,
        usage: { analyses_today: used, daily_limit: isAdmin ? null : plan.daily_analyses },
      });
    } catch (err) { fail(res, 'GET /billing/me', err, 'Could not load your plan.'); }
  });

  // POST /billing/checkout — prepaid: returns PayMongo's checkout page URL.
  app.post('/billing/checkout', requireAuth, async (req, res) => {
    if (!billingEnabled || !tablesReady) return res.status(503).json({ error: 'Buying Student Pro is not available right now.' });
    if (req.user.role === 'admin') return res.status(400).json({ error: 'Admins already have every Student Pro feature.' });
    try {
      const price = await priceById(Number(req.body?.price_id));
      if (!price || !price.is_active || price.billing !== 'prepaid') {
        return res.status(400).json({ error: 'That price is not available.' });
      }
      const [ins] = await db.query(
        `INSERT INTO payments (user_id, price_id, amount_centavos, status) VALUES (?, ?, ?, 'pending')`,
        [req.user.userId, price.id, price.amount_centavos]);
      const paymentId = ins.insertId;
      const attributes = {
        line_items: [{
          name: `${price.plan_name} (${periodLabel(price.duration_days)})`,
          amount: price.amount_centavos, currency: 'PHP', quantity: 1,
        }],
        payment_method_types: CHECKOUT_METHODS,
        description: `BugBeat ${price.plan_name}, ${periodLabel(price.duration_days)}`,
        reference_number: `BB-${paymentId}`,
        success_url: `${FRONTEND_URL}/payment-result.html?payment=${paymentId}`,
        cancel_url: `${FRONTEND_URL}/payment-result.html?payment=${paymentId}&cancelled=1`,
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
      };
      let session;
      try {
        session = await paymongo('POST', '/v1/checkout_sessions', attributes);
      } catch (err) {
        // A method the account hasn't enabled is refused: retry with card only.
        if (!(err instanceof PayMongoError) || err.status !== 400 || CHECKOUT_METHODS.join() === 'card') throw err;
        console.warn('[billing] checkout refused the method list, retrying with card only:', err.message);
        session = await paymongo('POST', '/v1/checkout_sessions', { ...attributes, payment_method_types: ['card'] });
      }
      await db.query('UPDATE payments SET checkout_session_id = ? WHERE id = ?', [session.id, paymentId]);
      res.json({ checkout_url: session.attributes.checkout_url, payment_id: paymentId });
    } catch (err) { fail(res, 'POST /billing/checkout', err, 'Could not start the payment. Please try again.'); }
  });

  // POST /billing/subscribe — auto-renew. The browser first creates a card
  // payment method with PayMongo's public key (the card number never
  // reaches this server) and sends its id here.
  app.post('/billing/subscribe', requireAuth, async (req, res) => {
    if (!billingEnabled || !tablesReady || !AUTO_RENEW_ON) return res.status(503).json({ error: 'Auto-renew is not available right now.' });
    if (req.user.role === 'admin') return res.status(400).json({ error: 'Admins already have every Student Pro feature.' });
    const pmId = String(req.body?.payment_method_id || '');
    if (!/^pm_[A-Za-z0-9]+$/.test(pmId)) return res.status(400).json({ error: 'Card details are missing.' });
    try {
      const price = await priceById(Number(req.body?.price_id));
      if (!price || !price.is_active || price.billing !== 'auto_renew') {
        return res.status(400).json({ error: 'That price is not available.' });
      }
      const [[existing]] = await db.query(
        `SELECT id FROM subscriptions WHERE user_id = ? AND source = 'auto_renew' AND auto_renew = 1
            AND status IN ('active','past_due')`, [req.user.userId]);
      if (existing) return res.status(409).json({ error: 'You already have auto-renew on. Cancel it first to switch.' });

      // 1. The PayMongo plan for this price (made once, then reused).
      let planId = price.paymongo_plan_id;
      if (!planId) {
        const base = {
          name: `BugBeat ${price.plan_name} (${periodLabel(price.duration_days)})`,
          description: `BugBeat ${price.plan_name}, renews every ${periodLabel(price.duration_days)}`,
          amount: price.amount_centavos, currency: 'PHP', interval_count: 1,
        };
        const tries = price.duration_days >= 365 ? ['yearly', 'year'] : ['monthly', 'month'];
        let lastErr;
        for (const interval of tries) {
          try { planId = (await paymongo('POST', '/v1/subscriptions/plans', { ...base, interval })).id; break; }
          catch (err) { lastErr = err; if (!(err instanceof PayMongoError) || err.status !== 400) throw err; }
        }
        if (!planId) throw lastErr;
        await db.query('UPDATE plan_prices SET paymongo_plan_id = ? WHERE id = ?', [planId, price.id]);
      }

      // 2. The user's PayMongo customer (made once).
      let [[cust]] = await db.query('SELECT paymongo_customer_id FROM billing_customers WHERE user_id = ?', [req.user.userId]);
      let customerId = cust?.paymongo_customer_id;
      if (!customerId) {
        const [[u]] = await db.query('SELECT username, nickname, email FROM users WHERE id = ?', [req.user.userId]);
        const customer = await paymongo('POST', '/v1/customers', {
          first_name: (u.nickname || u.username).slice(0, 50), last_name: 'BugBeat user',
          email: u.email, default_device: 'email',
        });
        customerId = customer.id;
        await db.query('INSERT INTO billing_customers (user_id, paymongo_customer_id) VALUES (?, ?)', [req.user.userId, customerId]);
      }

      // 3. The subscription; PayMongo makes its first invoice right away.
      const created = await paymongo('POST', '/v1/subscriptions', { customer_id: customerId, plan_id: planId });
      const inv = created.attributes?.latest_invoice || {};
      const intentId = inv.payment_intent?.id || inv.payment_intent_id || (typeof inv.payment_intent === 'string' ? inv.payment_intent : null);
      if (!intentId) throw new Error('PayMongo did not return a payment for the new subscription.');
      const [sub] = await db.query(
        `INSERT INTO subscriptions (user_id, plan_id, price_id, source, status, auto_renew, paymongo_subscription_id)
         VALUES (?, ?, ?, 'auto_renew', 'pending', 1, ?)`,
        [req.user.userId, price.plan_id, price.id, created.id]);
      await db.query(
        `INSERT INTO payments (user_id, price_id, subscription_id, payment_intent_id, amount_centavos, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [req.user.userId, price.id, sub.insertId, intentId, price.amount_centavos]);

      // 4. Pay the first invoice with the card (3-D Secure may need a redirect).
      const intent = await paymongo('POST', `/v1/payment_intents/${intentId}/attach`, {
        payment_method: pmId,
        return_url: `${FRONTEND_URL}/payment-result.html?subscription=${sub.insertId}`,
      });
      const status = intent.attributes?.status;
      if (status === 'awaiting_next_action') {
        return res.json({ redirect_url: intent.attributes.next_action?.redirect?.url, subscription_id: sub.insertId });
      }
      if (status === 'succeeded' || status === 'processing') {
        return res.json({ subscription_id: sub.insertId, status: 'processing' });
      }
      const why = intent.attributes?.last_payment_error?.failed_message || 'The card was declined.';
      await db.query(`UPDATE payments SET status = 'failed' WHERE subscription_id = ?`, [sub.insertId]);
      await db.query(`UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, cancelled_at = NOW() WHERE id = ?`, [sub.insertId]);
      res.status(402).json({ error: why });
    } catch (err) { fail(res, 'POST /billing/subscribe', err, err instanceof PayMongoError ? `Payment failed: ${err.message}` : 'Could not start auto-renew. Please try again.'); }
  });

  // POST /billing/cancel-renewal — stops future charges; Pro runs to the end
  // of the period already paid for.
  app.post('/billing/cancel-renewal', requireAuth, async (req, res) => {
    try {
      const [[sub]] = await db.query(
        `SELECT id, paymongo_subscription_id, ends_at FROM subscriptions
          WHERE user_id = ? AND source = 'auto_renew' AND auto_renew = 1 AND status IN ('active','past_due','pending')
          ORDER BY id DESC LIMIT 1`, [req.user.userId]);
      if (!sub) return res.status(404).json({ error: 'You have no auto-renew to cancel.' });
      try {
        await paymongo('POST', `/v1/subscriptions/${sub.paymongo_subscription_id}/cancel`, { cancellation_reason: 'other' });
      } catch (err) {
        if (!(err instanceof PayMongoError) || err.status !== 404) throw err;
        await paymongo('DELETE', `/v1/subscriptions/${sub.paymongo_subscription_id}`);
      }
      await db.query(
        `UPDATE subscriptions SET auto_renew = 0, status = IF(ends_at IS NULL, 'cancelled', status), cancelled_at = NOW() WHERE id = ?`,
        [sub.id]);
      res.json({ message: sub.ends_at ? 'Auto-renew is off. Student Pro stays on until the end of the period you paid for.' : 'Auto-renew is off.' });
    } catch (err) { fail(res, 'POST /billing/cancel-renewal', err, 'Could not cancel auto-renew. Please try again.'); }
  });

  // GET /billing/payments — the user's own payment history.
  app.get('/billing/payments', requireAuth, async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT pm.id, pm.amount_centavos, pm.status, pm.created_at, pm.paid_at,
                pp.billing, pp.duration_days, p.name AS plan_name
           FROM payments pm JOIN plan_prices pp ON pp.id = pm.price_id JOIN plans p ON p.id = pp.plan_id
          WHERE pm.user_id = ? ORDER BY pm.created_at DESC, pm.id DESC LIMIT 50`, [req.user.userId]);
      res.json({ payments: rows });
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ payments: [] });
      fail(res, 'GET /billing/payments', err, 'Could not load your payments.');
    }
  });

  // GET /billing/payment/:id — status of one of the user's payments
  // (the payment result page asks this while the webhook arrives).
  app.get('/billing/payment/:id', requireAuth, async (req, res) => {
    try {
      const [[row]] = await db.query(
        `SELECT pm.status, s.ends_at FROM payments pm LEFT JOIN subscriptions s ON s.id = pm.subscription_id
          WHERE pm.id = ? AND pm.user_id = ?`, [Number(req.params.id), req.user.userId]);
      if (!row) return res.status(404).json({ error: 'Payment not found.' });
      res.json({ status: row.status, pro_until: row.ends_at || null });
    } catch (err) { fail(res, 'GET /billing/payment', err, 'Could not check the payment.'); }
  });

  // GET /billing/subscription/:id — same, for the first auto-renew payment.
  app.get('/billing/subscription/:id', requireAuth, async (req, res) => {
    try {
      const [[row]] = await db.query(
        `SELECT status, ends_at FROM subscriptions WHERE id = ? AND user_id = ?`,
        [Number(req.params.id), req.user.userId]);
      if (!row) return res.status(404).json({ error: 'Subscription not found.' });
      res.json({ status: row.ends_at ? 'paid' : (row.status === 'cancelled' ? 'failed' : 'pending'), pro_until: row.ends_at || null });
    } catch (err) { fail(res, 'GET /billing/subscription', err, 'Could not check the subscription.'); }
  });

  // POST /webhooks/paymongo — PayMongo tells us a payment happened.
  app.post('/webhooks/paymongo', async (req, res) => {
    if (!verifyPaymongoSignature(req.get('Paymongo-Signature'), req.rawBody?.toString('utf8'))) {
      return res.status(401).json({ error: 'Invalid signature.' });
    }
    const event = req.body?.data;
    const type = event?.attributes?.type;
    const resource = event?.attributes?.data;
    const livemode = !!event?.attributes?.livemode;
    if (!event?.id || !type || !resource) return res.status(400).json({ error: 'Unexpected payload.' });
    try {
      const [ins] = await db.query('INSERT IGNORE INTO paymongo_events (event_id, event_type) VALUES (?, ?)', [event.id, type]);
      if (ins.affectedRows === 0) return res.json({ received: true, duplicate: true });
      try {
        if (type === 'checkout_session.payment.paid') await onCheckoutPaid(resource, livemode);
        else if (type === 'subscription.activated') await onSubscriptionActivated(resource, livemode);
        else if (type === 'subscription.invoice.paid') await onInvoicePaid(resource, livemode);
        else if (type === 'subscription.past_due') await onSubscriptionStatus(resource, 'past_due');
        else if (type === 'subscription.unpaid') await onSubscriptionStatus(resource, 'unpaid');
        else if (type === 'subscription.updated') await onSubscriptionStatus(resource, resource.attributes?.status);
      } catch (err) {
        // Let PayMongo retry this event later.
        await db.query('DELETE FROM paymongo_events WHERE event_id = ?', [event.id]).catch(() => {});
        throw err;
      }
      res.json({ received: true });
    } catch (err) {
      console.error('POST /webhooks/paymongo error:', type, err.message);
      res.status(500).json({ error: 'Could not process the event.' });
    }
  });

  // ── Admin ──────────────────────────────────────
  // GET /admin/billing — payments (filter by status), Pro users and prices.
  app.get('/admin/billing', requireAdmin, async (req, res) => {
    try {
      const status = ['pending', 'paid', 'failed'].includes(req.query.status) ? req.query.status : null;
      const [payments] = await db.query(
        `SELECT pm.id, pm.amount_centavos, pm.status, pm.livemode, pm.created_at, pm.paid_at,
                u.username, u.email, pp.billing, pp.duration_days
           FROM payments pm JOIN users u ON u.id = pm.user_id JOIN plan_prices pp ON pp.id = pm.price_id
          ${status ? 'WHERE pm.status = ?' : ''}
          ORDER BY pm.created_at DESC, pm.id DESC LIMIT 200`, status ? [status] : []);
      const [[{ pro_users }]] = await db.query(
        `SELECT COUNT(DISTINCT user_id) AS pro_users FROM subscriptions
          WHERE starts_at <= NOW() AND ends_at > NOW() AND status <> 'pending'`);
      const [[{ revenue }]] = await db.query(
        `SELECT COALESCE(SUM(amount_centavos), 0) AS revenue FROM payments WHERE status = 'paid'`);
      const [pro] = await db.query(
        `SELECT s.id, s.source, s.status, s.starts_at, s.ends_at, s.auto_renew, s.note,
                u.id AS user_id, u.username, u.email, g.username AS granted_by
           FROM subscriptions s JOIN users u ON u.id = s.user_id LEFT JOIN users g ON g.id = s.granted_by
          WHERE s.ends_at > NOW() AND s.status <> 'pending'
          ORDER BY s.ends_at DESC LIMIT 200`);
      const [prices] = await db.query(
        `SELECT pp.id, pp.billing, pp.duration_days, pp.amount_centavos, pp.is_active, p.name AS plan_name
           FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id ORDER BY pp.billing, pp.duration_days`);
      res.json({ payments, pro_users, revenue_centavos: Number(revenue), pro, prices, test_mode: testMode });
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') {
        return res.status(500).json({ error: 'The billing tables are missing. Run backend/migrations/billing.sql first.' });
      }
      fail(res, 'GET /admin/billing', err, 'Could not load billing.');
    }
  });

  // PATCH /admin/billing/prices/:id — turn a price on or off.
  app.patch('/admin/billing/prices/:id', requireAdmin, async (req, res) => {
    try {
      const on = req.body?.is_active ? 1 : 0;
      const [r] = await db.query('UPDATE plan_prices SET is_active = ? WHERE id = ?', [on, Number(req.params.id)]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Price not found.' });
      res.json({ message: on ? 'Price turned on.' : 'Price turned off.' });
    } catch (err) { fail(res, 'PATCH /admin/billing/prices', err, 'Could not update the price.'); }
  });

  // POST /admin/billing/grant — give an account Pro for a number of days.
  // Body: { user: username or email, days, note }
  app.post('/admin/billing/grant', requireAdmin, async (req, res) => {
    const who = String(req.body?.user || '').trim();
    const days = Math.floor(Number(req.body?.days));
    const note = String(req.body?.note || '').trim().slice(0, 255) || null;
    if (!who) return res.status(400).json({ error: 'Enter a username or email.' });
    if (!(days >= 1 && days <= 730)) return res.status(400).json({ error: 'Days must be between 1 and 730.' });
    const conn = await db.getConnection();
    try {
      const [[u]] = await conn.query('SELECT id, username, role FROM users WHERE username = ? OR email = ? LIMIT 1', [who, who]);
      if (!u) return res.status(404).json({ error: 'No account with that username or email.' });
      if (u.role === 'admin') return res.status(400).json({ error: 'Admins already have every Student Pro feature.' });
      const plans = await loadPlans();
      await conn.beginTransaction();
      const start = await nextStart(conn, u.id);
      const end = addDays(start, days);
      await conn.query(
        `INSERT INTO subscriptions (user_id, plan_id, source, status, starts_at, ends_at, granted_by, note)
         VALUES (?, ?, 'admin_grant', 'active', ?, ?, ?, ?)`,
        [u.id, plans.pro.id, start, end, req.user.userId, note]);
      await conn.commit();
      res.json({ message: `${u.username} has Student Pro until ${end.toISOString().slice(0, 10)}.`, ends_at: end });
    } catch (err) { await conn.rollback().catch(() => {}); fail(res, 'POST /admin/billing/grant', err, 'Could not give Student Pro.'); }
    finally { conn.release(); }
  });

  // POST /admin/billing/grants/:id/revoke — end a grant now. Paid periods
  // can't be revoked here (no refunds in test mode).
  app.post('/admin/billing/grants/:id/revoke', requireAdmin, async (req, res) => {
    try {
      const [r] = await db.query(
        `UPDATE subscriptions SET ends_at = NOW(), status = 'cancelled', cancelled_at = NOW()
          WHERE id = ? AND source = 'admin_grant' AND ends_at > NOW()`, [Number(req.params.id)]);
      if (!r.affectedRows) return res.status(404).json({ error: 'That grant was not found or has already ended.' });
      res.json({ message: 'Student Pro grant ended.' });
    } catch (err) { fail(res, 'POST /admin/billing/grants/revoke', err, 'Could not end the grant.'); }
  });
}

export { peso, periodLabel };
