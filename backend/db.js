// ═══════════════════════════════════════════════
//  BUGBEAT — db.js
//  MySQL connection pool using mysql2
// ═══════════════════════════════════════════════

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'bugbeat',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  // Local XAMPP MySQL doesn't use/require TLS, but Aiven (and most managed
  // MySQL hosts) reject plain connections outright. Set DB_SSL=true in the
  // deployed environment (Render) to turn this on; leave it unset locally.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
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