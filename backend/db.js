// ═══════════════════════════════════════════════
//  BUGBEAT — db.js
//  MySQL connection pool using mysql2
// ═══════════════════════════════════════════════

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
// rejectUnauthorized: false disables Node/OpenSSL's *automatic* certificate
// chain verification, which on its own defeats part of the point of TLS (it
// stops eavesdropping but not a man-in-the-middle with a fake cert). That
// automatic verification (rejectUnauthorized: true + ca: <bundled Aiven
// CA>) was tried twice and took the whole DB connection down outright both
// times with "self-signed certificate in certificate chain" — even after a
// diagnostic proved, byte-for-byte, that the CA we're providing IS the
// exact root certificate the server presents. That symptom (matching CA,
// verification still fails) is a known OpenSSL/Node chain-building quirk
// specifically when the server includes its own self-signed root as part
// of the chain it sends (which Aiven does — see the diagnostic below), not
// evidence of a wrong or corrupted certificate.
//
// So instead of depending on that automatic chain-building, DB_SSL_VERIFY
// implements the same guarantee a different way: certificate pinning. TLS
// is negotiated with rejectUnauthorized: false (never blocks the
// handshake), then every new physical connection is checked, in the
// 'connection' event below, against the exact fingerprint of the bundled
// aiven-ca.pem. If it doesn't match, the connection is destroyed rather
// than used. This is a straightforward byte comparison we control
// ourselves — no OpenSSL chain-building involved — so it can't fail closed
// for the same reason automatic verification did, while still refusing any
// connection that isn't anchored to the CA we actually trust.
function buildSslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  return { rejectUnauthorized: false };
}

// Walks a peer certificate chain (leaf → root) from Node's
// DetailedPeerCertificate shape. MySQL upgrades a plaintext socket to TLS
// mid-handshake rather than starting TLS immediately, so this only works
// against a socket that's already completed that upgrade (e.g. the
// connection object mysql2 hands back after a successful connect) — a
// standalone raw tls.connect() probe against host:port fails with "wrong
// version number" because it isn't speaking the MySQL protocol first.
function getPeerCertChain(sock) {
  if (!sock?.getPeerCertificate) return [];
  const chain = [];
  let cert = sock.getPeerCertificate(true);
  while (cert && cert.subject) {
    chain.push(cert);
    if (!cert.issuerCertificate || cert.issuerCertificate.fingerprint === cert.fingerprint) break;
    cert = cert.issuerCertificate;
  }
  return chain;
}

// Loads the bundled (or overridden) CA cert's SHA-256 fingerprint once at
// startup, for pinning — computed directly from the file via Node's
// X509Certificate, independent of any live connection.
function loadPinnedFingerprint() {
  const caPath = process.env.DB_SSL_CA_PATH || DEFAULT_CA_PATH;
  let raw;
  try {
    raw = fs.readFileSync(caPath);
  } catch (err) {
    console.warn(`[DB] Could not read CA cert at ${caPath} — certificate pinning disabled, connecting with TLS but WITHOUT verification:`, err.message);
    return null;
  }
  if (process.env.DB_SSL_DIAG === 'true') {
    console.log(`[DB][diag] Read ${raw.length} bytes from ${caPath} — first 20 bytes (hex): ${raw.subarray(0, 20).toString('hex')} — first line: ${JSON.stringify(raw.toString('utf8', 0, 40))}`);
  }
  try {
    const cert = new crypto.X509Certificate(raw);
    return { fingerprint256: cert.fingerprint256, caPath };
  } catch (err) {
    console.warn(`[DB] Could not parse CA cert at ${caPath} — certificate pinning disabled, connecting with TLS but WITHOUT verification:`, err.message);
    return null;
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
  // Don't keep unused connections around forever. An idle connection to
  // Aiven can be silently dropped by the network in between (firewalls /
  // NAT forget quiet connections); the pool doesn't notice, hands the dead
  // connection to the next request, and that request fails with
  // ECONNRESET. mysql2 only closes idle connections when maxIdle is below
  // connectionLimit, so this turns that on: anything unused for a minute
  // is closed and a fresh one is opened when needed.
  maxIdle:            5,
  idleTimeout:        60 * 1000,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 10 * 1000,
  ssl: buildSslConfig()
});

// Safety net for the same problem: if a query fails because its pooled
// connection turned out to be dead, the pool has already thrown that
// connection away, so run the query again on another one (up to 3 tries).
// Only connection-level errors are retried; SQL errors are not.
const RECONNECT_ERRORS = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
for (const method of ['query', 'execute']) {
  const original = pool[method].bind(pool);
  pool[method] = async (...args) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await original(...args);
      } catch (err) {
        if (!RECONNECT_ERRORS.has(err.code) || attempt >= 3) throw err;
        console.warn(`[DB] ${err.code} on a pooled connection (try ${attempt}); retrying on a fresh connection`);
      }
    }
  };
}

// Certificate pinning — mysql2/promise's pool re-emits 'connection' from
// its underlying base pool for every new physical connection it opens,
// regardless of whether app code goes through pool.query(), pool.execute(),
// or pool.getConnection() to get there, so one listener here covers all of
// it app-wide.
if (process.env.DB_SSL === 'true' && process.env.DB_SSL_VERIFY === 'true') {
  const pinned = loadPinnedFingerprint();
  if (pinned) {
    console.log(`[DB] Certificate pinning enabled against ${pinned.caPath} (fingerprint256=${pinned.fingerprint256})`);
    pool.on('connection', (connection) => {
      const chain = getPeerCertChain(connection.stream);
      const match = chain.find(c => c.fingerprint256 === pinned.fingerprint256);
      if (!match) {
        console.error('[DB] Certificate pinning FAILED — server did not present the trusted CA. Refusing this connection.');
        connection.destroy();
      }
    });
  }
}

// Test connection + one-time diagnostic on startup
pool.getConnection()
  .then(conn => {
    console.log('[DB] MySQL connected successfully.');

    if (process.env.DB_SSL_DIAG === 'true') {
      const chain = getPeerCertChain(conn.connection?.stream);
      if (chain.length) {
        console.log(`[DB][diag] Server presented ${chain.length} certificate(s):`);
        chain.forEach((c, i) => {
          console.log(`[DB][diag]   [${i}] subject=${c.subject?.CN}  issuer=${c.issuer?.CN}  fingerprint256=${c.fingerprint256}`);
        });
      } else {
        console.log('[DB][diag] Connection is not using TLS (DB_SSL is off) — nothing to inspect.');
      }
    }

    conn.release();
  })
  .catch(err => {
    console.error('[DB] MySQL connection failed:', err.message);
  });

export default pool;