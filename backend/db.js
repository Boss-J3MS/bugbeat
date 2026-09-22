// ═══════════════════════════════════════════════
//  BUGBEAT — db.js
//  MySQL connection pool using mysql2
// ═══════════════════════════════════════════════

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
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
// man-in-the-middle with a fake cert). DB_SSL_CA_PATH can still override
// which CA file to use (e.g. for local testing against Aiven), but defaults
// to the bundled aiven-ca.pem so production needs no extra configuration.
// Falls back to the old permissive behavior only if the CA file can't be
// read, so a missing/bad cert degrades gracefully instead of taking the DB
// connection down outright.
function buildSslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  const caPath = process.env.DB_SSL_CA_PATH || DEFAULT_CA_PATH;
  try {
    return {
      ca: fs.readFileSync(caPath),
      rejectUnauthorized: true
    };
  } catch (err) {
    console.warn(`[DB] Could not read CA cert at ${caPath} — connecting with TLS but WITHOUT certificate verification:`, err.message);
    return { rejectUnauthorized: false };
  }
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