// ═══════════════════════════════════════════════
//  BUGBEAT — auth.js
//  JWT helper functions + auth middleware
// ═══════════════════════════════════════════════

import jwt    from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import db     from './db.js';
import crypto from 'crypto';
dotenv.config();

// JWT_SECRET must be set via environment variable — no insecure fallback.
// Running with a hardcoded/public secret would let anyone forge valid
// tokens (including admin tokens), so fail loudly at startup instead.
if (!process.env.JWT_SECRET) {
  console.error('[auth] FATAL: JWT_SECRET environment variable is not set. Refusing to start with an insecure default secret.');
  process.exit(1);
}

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const SALT_ROUNDS = 12;

// ── Password hashing ───────────────────────────
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Minimum password strength: 8+ chars, at least one letter and one number.
// Returns { valid, error } so the caller can send back a useful message.
export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long.' };
  }
  if (password.length > 128) {
    return { valid: false, error: 'Password is too long.' };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one letter and one number.' };
  }
  return { valid: true };
}

// ── JWT ────────────────────────────────────────
export function generateToken(payload) {
  // jwtid makes every token unique, even for two logins in the same second
  // (the token is how a session — and "this device" — is told apart).
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES, jwtid: crypto.randomUUID() });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── Auth middleware ────────────────────────────
// Verifies the JWT signature AND checks that a matching, unexpired row
// still exists in the `sessions` table. A valid signature alone isn't
// enough — without the DB check, logging out, getting demoted, or getting
// deleted by an admin would not actually revoke a token until it expired
// naturally (up to JWT_EXPIRES later), since /auth/logout only ever
// deleted the sessions row and nothing ever re-checked it.
export async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided. Please log in.' });
  }
  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid token. Please log in.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT id FROM sessions WHERE token = ? AND expires_at > NOW() LIMIT 1',
      [token]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Session expired or revoked. Please log in again.' });
    }
    touchSession(rows[0].id);
  } catch (err) {
    console.error('[auth] session lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication check failed. Please try again.' });
  }

  req.user = decoded; // { userId, email, username, role }
  next();
}

// Updates sessions.last_active (shown in Settings → Devices), at most once
// every 5 minutes per session, without making the request wait. Quietly
// does nothing if the column hasn't been added yet.
let lastActiveMissing = false;
function touchSession(id) {
  if (lastActiveMissing) return;
  db.query(
    `UPDATE sessions SET last_active = NOW()
     WHERE id = ? AND (last_active IS NULL OR last_active < NOW() - INTERVAL 5 MINUTE)`,
    [id]
  ).catch(err => {
    if (err.code === 'ER_BAD_FIELD_ERROR') lastActiveMissing = true;
    else console.warn('[auth] last_active update failed:', err.message);
  });
}

// ── Admin middleware ───────────────────────────
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }
    next();
  });
}