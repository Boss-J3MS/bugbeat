// ═══════════════════════════════════════════════
//  BUGBEAT — billing.js
//  Plans (Free / Student Pro), limits, and payments through Xendit.
//
//  Two ways to pay for Student Pro, both on Xendit's own payment page
//  (a Payment Session), so card details never reach BugBeat:
//    • prepaid     — one payment buys 30 or 365 days (cards, e-wallets and
//                    other methods Xendit offers).
//    • auto_renew  — a Xendit subscription charges the saved payment method
//                    every month or year until it is cancelled.
//  A payment counts only when Xendit says so: its webhook
//  (POST /webhooks/xendit), or the session status the server asks Xendit
//  for when the student comes back from the payment page. Admins always
//  have Pro features and can give Pro to an account (admin_grant).
//
//  Settings (Render → Environment, and backend/.env locally):
//    XENDIT_SECRET_KEY     xnd_development_… (test mode) — server only
//    XENDIT_WEBHOOK_TOKEN  the webhook verification token from Xendit
//    XENDIT_AUTO_RENEW     'off' hides the auto-renew option
//    XENDIT_CHANNELS       optional: payment channels to offer,
//                          comma-separated (default: all the account has)
//  Without XENDIT_SECRET_KEY, buying is switched off but the plans and
//  limits still work.
// ═══════════════════════════════════════════════

import crypto from 'crypto';
import db from './db.js';
import { requireAuth, requireAdmin, verifyToken } from './auth.js';

const XENDIT_API     = 'https://api.xendit.co';
const SECRET_KEY     = process.env.XENDIT_SECRET_KEY || '';
const WEBHOOK_TOKEN  = process.env.XENDIT_WEBHOOK_TOKEN || '';
const AUTO_RENEW_ON  = process.env.XENDIT_AUTO_RENEW !== 'off';
const CHANNELS       = (process.env.XENDIT_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
const FRONTEND_URL   = (process.env.FRONTEND_URL || 'http://localhost:5500').replace(/\/+$/, '');

export const billingEnabled = SECRET_KEY.length > 0;
const testMode = !SECRET_KEY || SECRET_KEY.startsWith('xnd_development_');
if (!billingEnabled) console.warn('[billing] XENDIT_SECRET_KEY not set — buying Student Pro is switched off.');
if (billingEnabled && !WEBHOOK_TOKEN) console.warn('[billing] XENDIT_WEBHOOK_TOKEN not set — webhooks are refused; payments are confirmed when the student returns.');

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


// ── Xendit API ─────────────────────────────────
class XenditError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error_code || `Xendit responded ${status}`);
    this.status = status;
    this.code = body?.error_code || null;
  }
}

async function xendit(method, path, body) {
  const res = await fetch(`${XENDIT_API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${SECRET_KEY}:`).toString('base64'),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new XenditError(res.status, data);
  return data;
}

// ── Webhook verification ───────────────────────
// Xendit sends the account's webhook verification token in x-callback-token.
export function verifyWebhookToken(given, expected = WEBHOOK_TOKEN) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
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

// References sent to Xendit, so a completed session points back to the
// payment or the subscription it belongs to.
const payRef = id => `bugbeat-pay-${id}`;
const subRef = id => `bugbeat-sub-${id}`;
function parseRef(ref) {
  const m = /^bugbeat-(pay|sub)-(\d+)$/.exec(String(ref || ''));
  return m ? { kind: m[1], id: Number(m[2]) } : null;
}

// Creates a Xendit payment session for a user (the hosted payment page).
// The Xendit customer is made on the first payment and reused after that.
async function createSession(userId, fields) {
  const [[cust]] = await db.query('SELECT provider_customer_id FROM billing_customers WHERE user_id = ?', [userId]);
  const base = {
    session_type: 'PAY', mode: 'PAYMENT_LINK', currency: 'PHP', country: 'PH', locale: 'en',
    ...(CHANNELS.length && { allowed_payment_channels: CHANNELS }),
    ...fields,
  };
  if (cust) return xendit('POST', '/sessions', { ...base, customer_id: cust.provider_customer_id });

  const [[u]] = await db.query('SELECT username, nickname, email FROM users WHERE id = ?', [userId]);
  const customer = (ref) => ({
    type: 'INDIVIDUAL', reference_id: ref,
    individual_detail: { given_names: (u.nickname || u.username).slice(0, 50) },
    ...(u.email && u.email.length <= 50 && { email: u.email }),
  });
  let session;
  try {
    session = await xendit('POST', '/sessions', { ...base, customer: customer(`bugbeat-user-${userId}`) });
  } catch (err) {
    // A customer with that reference may already exist at Xendit.
    if (!(err instanceof XenditError) || err.status !== 400 || !/customer|reference|duplicate/i.test(err.message)) throw err;
    session = await xendit('POST', '/sessions', { ...base, customer: customer(`bugbeat-user-${userId}-${Date.now()}`) });
  }
  if (session.customer_id) {
    await db.query('INSERT IGNORE INTO billing_customers (user_id, provider_customer_id) VALUES (?, ?)', [userId, session.customer_id]);
  }
  return session;
}

// ── Payment results (webhook or status check) ──
// Prepaid: the payment went through → a Pro period of duration_days.
async function prepaidPaid(paymentId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[pay]] = await conn.query(
      `SELECT pm.*, pp.duration_days, pp.plan_id FROM payments pm
         JOIN plan_prices pp ON pp.id = pm.price_id
        WHERE pm.id = ? AND pm.subscription_id IS NULL FOR UPDATE`, [paymentId]);
    if (!pay || pay.status === 'paid') { await conn.commit(); return; }
    const start = await nextStart(conn, pay.user_id);
    const end = addDays(start, pay.duration_days);
    const [sub] = await conn.query(
      `INSERT INTO subscriptions (user_id, plan_id, price_id, source, status, starts_at, ends_at)
       VALUES (?, ?, ?, 'prepaid', 'active', ?, ?)`,
      [pay.user_id, pay.plan_id, pay.price_id, start, end]);
    await conn.query(
      `UPDATE payments SET status = 'paid', paid_at = NOW(), subscription_id = ?, test_mode = ? WHERE id = ?`,
      [sub.insertId, testMode ? 1 : 0, pay.id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}

async function lockSub(conn, where, value) {
  const [[sub]] = await conn.query(
    `SELECT s.*, pp.duration_days FROM subscriptions s
       JOIN plan_prices pp ON pp.id = s.price_id
      WHERE s.${where} = ? AND s.source = 'auto_renew' FOR UPDATE`, [value]);
  return sub || null;
}

// Auto-renew: the first payment went through → Pro starts. Safe to call
// more than once (the session webhook, the first cycle webhook and the
// status check can all report it).
async function subscriptionStarted(subId, planId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const sub = await lockSub(conn, 'id', subId);
    if (!sub) { await conn.commit(); return; }
    if (planId && !sub.provider_plan_id) {
      await conn.query('UPDATE subscriptions SET provider_plan_id = ? WHERE id = ?', [planId, sub.id]);
    }
    if (!sub.ends_at) {
      const start = await nextStart(conn, sub.user_id);
      await conn.query(
        `UPDATE subscriptions SET status = 'active', starts_at = ?, ends_at = ? WHERE id = ?`,
        [start, addDays(start, sub.duration_days), sub.id]);
      await conn.query(
        `UPDATE payments SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), test_mode = ?
          WHERE subscription_id = ? AND cycle_id IS NULL AND status = 'pending'`,
        [testMode ? 1 : 0, sub.id]);
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}

async function sessionCompleted(data) {
  const ref = parseRef(data.reference_id);
  if (!ref) return;
  if (ref.kind === 'pay') await prepaidPaid(ref.id);
  else await subscriptionStarted(ref.id, data.recurring_plan_id || null);
}

async function sessionEnded(data) {
  const ref = parseRef(data.reference_id);
  if (!ref) return;
  if (ref.kind === 'pay') {
    await db.query(`UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'`, [ref.id]);
  } else {
    await db.query(`UPDATE payments SET status = 'expired' WHERE subscription_id = ? AND status = 'pending'`, [ref.id]);
    await db.query(
      `UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, cancelled_at = NOW()
        WHERE id = ? AND ends_at IS NULL`, [ref.id]);
  }
}

// A recurring cycle was charged. The first one (charged when the plan was
// made) only confirms the start; later ones add a period each.
async function cycleSucceeded(cycle) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const sub = await lockSub(conn, 'provider_plan_id', cycle.plan_id);
    if (!sub) {
      await conn.commit();
      // The plan id isn't saved yet (its session result hasn't arrived):
      // fail so Xendit sends this event again later.
      throw Object.assign(new Error(`No subscription for plan ${cycle.plan_id} yet`), { retry: true });
    }
    const [[seen]] = await conn.query('SELECT id FROM payments WHERE cycle_id = ?', [cycle.id]);
    if (seen) { await conn.commit(); return; }
    const first = cycle.type === 'IMMEDIATE' || Number(cycle.cycle_number) === 1;
    const [[firstPay]] = await conn.query(
      `SELECT id FROM payments WHERE subscription_id = ? AND cycle_id IS NULL ORDER BY id LIMIT 1 FOR UPDATE`, [sub.id]);
    if (first || (!sub.ends_at && firstPay)) {
      if (!sub.ends_at) {
        const start = await nextStart(conn, sub.user_id);
        await conn.query(`UPDATE subscriptions SET status = 'active', starts_at = ?, ends_at = ? WHERE id = ?`,
          [start, addDays(start, sub.duration_days), sub.id]);
      }
      if (firstPay) {
        await conn.query(
          `UPDATE payments SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), cycle_id = ?, test_mode = ? WHERE id = ?`,
          [cycle.id, testMode ? 1 : 0, firstPay.id]);
      }
    } else {
      const from = sub.ends_at && new Date(sub.ends_at) > new Date() ? new Date(sub.ends_at) : new Date();
      await conn.query(`UPDATE subscriptions SET status = 'active', ends_at = ? WHERE id = ?`,
        [addDays(from, sub.duration_days), sub.id]);
      const [[price]] = await conn.query('SELECT amount_centavos FROM plan_prices WHERE id = ?', [sub.price_id]);
      await conn.query(
        `INSERT INTO payments (user_id, price_id, subscription_id, cycle_id, amount_centavos, status, test_mode, paid_at)
         VALUES (?, ?, ?, ?, ?, 'paid', ?, NOW())`,
        [sub.user_id, sub.price_id, sub.id, cycle.id,
         Math.round(Number(cycle.amount) * 100) || price.amount_centavos, testMode ? 1 : 0]);
    }
    await conn.commit();
  } catch (err) { if (!err.retry) await conn.rollback().catch(() => {}); throw err; }
  finally { conn.release(); }
}

async function planStatus(planId, what) {
  if (what === 'past_due') {
    // A renewal failed; Pro still runs to the end of the paid period.
    await db.query(`UPDATE subscriptions SET status = 'past_due' WHERE provider_plan_id = ? AND ends_at IS NOT NULL`, [planId]);
  } else if (what === 'stopped') {
    await db.query(
      `UPDATE subscriptions SET auto_renew = 0, cancelled_at = COALESCE(cancelled_at, NOW()),
              status = IF(ends_at IS NULL, 'cancelled', status)
        WHERE provider_plan_id = ?`, [planId]);
  }
}

// Asks Xendit for a pending payment's session, in case its webhook hasn't
// arrived (or isn't set up). Returns nothing; the tables are updated.
async function syncSession(sessionId) {
  if (!billingEnabled || !sessionId) return;
  try {
    const s = await xendit('GET', `/sessions/${encodeURIComponent(sessionId)}`);
    if (s.status === 'COMPLETED') await sessionCompleted(s);
    else if (s.status === 'EXPIRED' || s.status === 'CANCELED') await sessionEnded(s);
  } catch (err) {
    console.warn('[billing] session status check failed:', err.message);
  }
}

// ── Routes ─────────────────────────────────────
// opts.clientIp: the server's function for a request's real IP address.
export function registerBillingRoutes(app, { clientIp, errorRef }) {
  const fail = (res, where, err, message) => {
    console.error(`${where} error:`, err.message);
    res.status(err instanceof XenditError ? 502 : 500)
       .json({ error: message, ref: errorRef(err) });
  };
  const returnUrl = (q) => `${FRONTEND_URL}/payment-result.html?${q}`;

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

  const canBuy = (req, res) => {
    if (!billingEnabled || !tablesReady) { res.status(503).json({ error: 'Buying Student Pro is not available right now.' }); return false; }
    if (req.user.role === 'admin') { res.status(400).json({ error: 'Admins already have every Student Pro feature.' }); return false; }
    return true;
  };

  // POST /billing/checkout — prepaid: returns Xendit's payment page URL.
  app.post('/billing/checkout', requireAuth, async (req, res) => {
    if (!canBuy(req, res)) return;
    try {
      const price = await priceById(Number(req.body?.price_id));
      if (!price || !price.is_active || price.billing !== 'prepaid') {
        return res.status(400).json({ error: 'That price is not available.' });
      }
      const [ins] = await db.query(
        `INSERT INTO payments (user_id, price_id, amount_centavos, status, test_mode) VALUES (?, ?, ?, 'pending', ?)`,
        [req.user.userId, price.id, price.amount_centavos, testMode ? 1 : 0]);
      const paymentId = ins.insertId;
      const session = await createSession(req.user.userId, {
        reference_id: payRef(paymentId),
        session_type: 'PAY',
        amount: price.amount_centavos / 100,
        description: `BugBeat ${price.plan_name}, ${periodLabel(price.duration_days)}`,
        success_return_url: returnUrl(`payment=${paymentId}`),
        cancel_return_url: returnUrl(`payment=${paymentId}&cancelled=1`),
        metadata: { payment_id: String(paymentId) },
      });
      await db.query('UPDATE payments SET session_id = ? WHERE id = ?', [session.payment_session_id, paymentId]);
      res.json({ checkout_url: session.payment_link_url, payment_id: paymentId });
    } catch (err) { fail(res, 'POST /billing/checkout', err, 'Could not start the payment. Please try again.'); }
  });

  // POST /billing/subscribe — auto-renew: returns Xendit's payment page URL,
  // where the student pays the first period and saves the payment method.
  app.post('/billing/subscribe', requireAuth, async (req, res) => {
    if (!canBuy(req, res)) return;
    if (!AUTO_RENEW_ON) return res.status(503).json({ error: 'Auto-renew is not available right now.' });
    try {
      const price = await priceById(Number(req.body?.price_id));
      if (!price || !price.is_active || price.billing !== 'auto_renew') {
        return res.status(400).json({ error: 'That price is not available.' });
      }
      const [[existing]] = await db.query(
        `SELECT id FROM subscriptions WHERE user_id = ? AND source = 'auto_renew' AND auto_renew = 1
            AND status IN ('active','past_due')`, [req.user.userId]);
      if (existing) return res.status(409).json({ error: 'You already have auto-renew on. Cancel it first to switch.' });

      const [sub] = await db.query(
        `INSERT INTO subscriptions (user_id, plan_id, price_id, source, status, auto_renew)
         VALUES (?, ?, ?, 'auto_renew', 'pending', 1)`, [req.user.userId, price.plan_id, price.id]);
      const subId = sub.insertId;
      const [pay] = await db.query(
        `INSERT INTO payments (user_id, price_id, subscription_id, amount_centavos, status, test_mode)
         VALUES (?, ?, ?, ?, 'pending', ?)`, [req.user.userId, price.id, subId, price.amount_centavos, testMode ? 1 : 0]);
      const yearly = price.duration_days >= 365;
      const session = await createSession(req.user.userId, {
        reference_id: subRef(subId),
        session_type: 'SUBSCRIPTION',
        amount: price.amount_centavos / 100,
        description: `BugBeat ${price.plan_name}, renews every ${yearly ? 'year' : 'month'}`,
        subscription: {
          schedule: { interval: 'MONTH', interval_count: yearly ? 12 : 1 },
          failed_cycle_action: 'STOP',
        },
        success_return_url: returnUrl(`subscription=${subId}`),
        cancel_return_url: returnUrl(`subscription=${subId}&cancelled=1`),
        metadata: { subscription_id: String(subId) },
      });
      await db.query('UPDATE subscriptions SET provider_session_id = ?, provider_plan_id = ? WHERE id = ?',
        [session.payment_session_id, session.recurring_plan_id || null, subId]);
      await db.query('UPDATE payments SET session_id = ? WHERE id = ?', [session.payment_session_id, pay.insertId]);
      res.json({ checkout_url: session.payment_link_url, subscription_id: subId });
    } catch (err) { fail(res, 'POST /billing/subscribe', err, 'Could not start auto-renew. Please try again.'); }
  });

  // POST /billing/cancel-renewal — stops future charges; Pro runs to the end
  // of the period already paid for.
  app.post('/billing/cancel-renewal', requireAuth, async (req, res) => {
    try {
      const [[sub]] = await db.query(
        `SELECT id, provider_plan_id, ends_at FROM subscriptions
          WHERE user_id = ? AND source = 'auto_renew' AND auto_renew = 1 AND status IN ('active','past_due','pending')
          ORDER BY id DESC LIMIT 1`, [req.user.userId]);
      if (!sub) return res.status(404).json({ error: 'You have no auto-renew to cancel.' });
      if (sub.provider_plan_id) {
        try {
          await xendit('POST', `/recurring/plans/${encodeURIComponent(sub.provider_plan_id)}/deactivate`);
        } catch (err) {
          // Already inactive at Xendit is fine; anything else is an error.
          if (!(err instanceof XenditError) || err.status !== 404) throw err;
        }
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

  // GET /billing/payment/:id — status of one of the user's payments (the
  // payment result page asks this). While pending, Xendit is asked directly.
  app.get('/billing/payment/:id', requireAuth, async (req, res) => {
    try {
      const sql = `SELECT pm.status, pm.session_id, s.ends_at FROM payments pm
                     LEFT JOIN subscriptions s ON s.id = pm.subscription_id
                    WHERE pm.id = ? AND pm.user_id = ?`;
      const args = [Number(req.params.id), req.user.userId];
      let [[row]] = await db.query(sql, args);
      if (!row) return res.status(404).json({ error: 'Payment not found.' });
      if (row.status === 'pending' && row.session_id) {
        await syncSession(row.session_id);
        [[row]] = await db.query(sql, args);
      }
      res.json({ status: row.status, pro_until: row.ends_at || null });
    } catch (err) { fail(res, 'GET /billing/payment', err, 'Could not check the payment.'); }
  });

  // GET /billing/subscription/:id — same, for the first auto-renew payment.
  app.get('/billing/subscription/:id', requireAuth, async (req, res) => {
    try {
      const sql = 'SELECT status, ends_at, provider_session_id FROM subscriptions WHERE id = ? AND user_id = ?';
      const args = [Number(req.params.id), req.user.userId];
      let [[row]] = await db.query(sql, args);
      if (!row) return res.status(404).json({ error: 'Subscription not found.' });
      if (!row.ends_at && row.status === 'pending' && row.provider_session_id) {
        await syncSession(row.provider_session_id);
        [[row]] = await db.query(sql, args);
      }
      res.json({ status: row.ends_at ? 'paid' : (row.status === 'cancelled' ? 'failed' : 'pending'), pro_until: row.ends_at || null });
    } catch (err) { fail(res, 'GET /billing/subscription', err, 'Could not check the subscription.'); }
  });

  // POST /webhooks/xendit — Xendit tells us a payment happened.
  app.post('/webhooks/xendit', async (req, res) => {
    if (!verifyWebhookToken(req.get('x-callback-token'))) {
      return res.status(401).json({ error: 'Invalid token.' });
    }
    const type = req.body?.event;
    const data = req.body?.data;
    if (!type || !data) return res.status(400).json({ error: 'Unexpected payload.' });
    const key = crypto.createHash('sha256').update(req.rawBody || JSON.stringify(req.body)).digest('hex');
    try {
      const [ins] = await db.query('INSERT IGNORE INTO payment_events (event_key, event_type) VALUES (?, ?)', [key, type]);
      if (ins.affectedRows === 0) return res.json({ received: true, duplicate: true });
      try {
        if (type === 'payment_session.completed') await sessionCompleted(data);
        else if (type === 'payment_session.expired') await sessionEnded(data);
        else if (type === 'recurring.plan.activated') {
          const ref = parseRef(data.reference_id);
          if (ref?.kind === 'sub') await subscriptionStarted(ref.id, data.id);
        }
        else if (type === 'recurring.cycle.succeeded') await cycleSucceeded(data);
        else if (type === 'recurring.cycle.retrying') await planStatus(data.plan_id, 'past_due');
        else if (type === 'recurring.cycle.failed') { await planStatus(data.plan_id, 'past_due'); await planStatus(data.plan_id, 'stopped'); }
        else if (type === 'recurring.plan.inactivated') await planStatus(data.id, 'stopped');
      } catch (err) {
        // Let Xendit retry this delivery later.
        await db.query('DELETE FROM payment_events WHERE event_key = ?', [key]).catch(() => {});
        throw err;
      }
      res.json({ received: true });
    } catch (err) {
      if (!err.retry) console.error('POST /webhooks/xendit error:', type, err.message);
      res.status(500).json({ error: 'Could not process the event.' });
    }
  });

  // ── Admin ──────────────────────────────────────
  // GET /admin/billing — payments (filter by status), Pro users and prices.
  app.get('/admin/billing', requireAdmin, async (req, res) => {
    try {
      const status = ['pending', 'paid', 'failed', 'expired'].includes(req.query.status) ? req.query.status : null;
      const [payments] = await db.query(
        `SELECT pm.id, pm.amount_centavos, pm.status, pm.test_mode, pm.created_at, pm.paid_at,
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

