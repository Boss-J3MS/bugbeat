// ═══════════════════════════════════════════════
//  BUGBEAT — db.js
//  MySQL connection pool using mysql2
// ═══════════════════════════════════════════════

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import tls from 'tls';
import { fileURLToPath } from 'url';
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Aiven's CA certificate is public information (no private key in it —
// it's only used to verify the server, not to authenticate as anyone), so
// it's committed straight into the repo rather than pasted into a Render
// Secret File. That sidesteps a real failure mode: copy/pasting a multi-line
// PEM through a web textarea is an easy way to corrupt it (stray
// whitespace, smart quotes, a dropped newline), which is exactly what broke
// the first attempt at this (TLS failed with "self-signed certificate in
// certificate chain" once DB_SSL_CA_PATH pointed at a pasted-in file).
// Committing the actual file means git carries the exact bytes.
const DEFAULT_CA_PATH = path.join(__dirname, 'aiven-ca.pem');

// Local XAMPP MySQL doesn't use/require TLS, but Aiven (and most managed
// MySQL hosts) reject plain connections outright. Set DB_SSL=true in the
// deployed environment (Render) to turn this on; leave it unset locally.
//
// rejectUnauthorized: false disables certificate verification entirely,
// which defeats the point of TLS (it stops eavesdropping but not a
// man-in-the-middle with a fake cert). Full verification is opt-in via
// DB_SSL_VERIFY=true (using the bundled aiven-ca.pem, or DB_SSL_CA_PATH to
// override which file) rather than the default, because it has twice taken
// the whole DB connection down outright in production with a
// "self-signed certificate in certificate chain" TLS error — even with a
// cert independently confirmed valid via OpenSSL — and that failure mode is
// worse than running unverified while it's debugged. Toggle it on
// deliberately once that's root-caused, not automatically on deploy.
function buildSslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  if (process.env.DB_SSL_VERIFY === 'true') {
    const caPath = process.env.DB_SSL_CA_PATH || DEFAULT_CA_PATH;
    try {
      return {
        ca: fs.readFileSync(caPath),
        rejectUnauthorized: true
      };
    } catch (err) {
      console.warn(`[DB] Could not read CA cert at ${caPath} — connecting with TLS but WITHOUT certificate verification:`, err.message);
    }
  }
  return { rejectUnauthorized: false };
}

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'bugbeat',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  ssl: buildSslConfig()
});

// ── One-time TLS diagnostic ─────────────────────
// Full cert verification (DB_SSL_VERIFY=true) failed twice against a CA
// file independently confirmed valid via OpenSSL, so rather than guess at
// why, this opens its own raw TLS probe to the DB host on startup and logs
// the actual certificate chain the server presents (subject/issuer/
// fingerprint for each cert, leaf to root). Compare the root's fingerprint
// here against the bundled aiven-ca.pem's — a mismatch means the wrong CA
// was downloaded (e.g. a different project/service, or Aiven rotated it
// since); a match means the problem is elsewhere. This is a separate
// one-off socket — it doesn't touch the real connection pool above either
// way, so it's safe to leave running.
if (process.env.DB_SSL === 'true' && process.env.DB_SSL_DIAG === 'true') {
  const sock = tls.connect(
    { host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306, rejectUnauthorized: false },
    () => {
      const chain = [];
      let cert = sock.getPeerCertificate(true);
      while (cert && cert.subject) {
        chain.push(cert);
        if (!cert.issuerCertificate || cert.issuerCertificate.fingerprint === cert.fingerprint) break;
        cert = cert.issuerCertificate;
      }
      console.log(`[DB][diag] Server presented ${chain.length} certificate(s):`);
      chain.forEach((c, i) => {
        console.log(`[DB][diag]   [${i}] subject=${c.subject?.CN}  issuer=${c.issuer?.CN}  fingerprint=${c.fingerprint}`);
      });
      sock.end();
    }
  );
  sock.on('error', err => console.error('[DB][diag] TLS probe failed:', err.message));
}

// Test connection on startup
pool.getConnection()
  .then(conn => {
    console.log('[DB] MySQL connected successfully.');
    conn.release();
  })
  .catch(err => {
    console.error('[DB] MySQL connection failed:', err.message);
  });

export default pool;