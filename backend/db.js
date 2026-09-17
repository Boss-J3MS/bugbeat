// ═══════════════════════════════════════════════
//  BUGBEAT — db.js
//  MySQL connection pool using mysql2
// ═══════════════════════════════════════════════

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

// Local XAMPP MySQL doesn't use/require TLS, but Aiven (and most managed
// MySQL hosts) reject plain connections outright. Set DB_SSL=true in the
// deployed environment (Render) to turn this on; leave it unset locally.
//
// rejectUnauthorized: false disables certificate verification entirely,
// which defeats the point of TLS (it stops eavesdropping but not a
// man-in-the-middle with a fake cert). Point DB_SSL_CA_PATH at Aiven's
// downloaded CA certificate (ca.pem, from the Aiven console) to verify the
// server properly. Falls back to the old permissive behavior only if no CA
// path is provided, so existing deployments don't break outright — but the
// CA path should be set as soon as possible.
function buildSslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  if (process.env.DB_SSL_CA_PATH) {
    try {
      return {
        ca: fs.readFileSync(process.env.DB_SSL_CA_PATH),
        rejectUnauthorized: true
      };
    } catch (err) {
      console.error('[DB] Could not read DB_SSL_CA_PATH, falling back to unverified TLS:', err.message);
    }
  } else {
    console.warn('[DB] DB_SSL_CA_PATH not set — connecting with TLS but WITHOUT certificate verification. Set DB_SSL_CA_PATH to Aiven\'s ca.pem for a fully verified connection.');
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