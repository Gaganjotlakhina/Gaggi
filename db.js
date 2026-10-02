// Postgres schema + helpers (pg Pool, DATABASE_URL env).
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
const isLocal = !DATABASE_URL || /localhost|127\.0\.0\.1|host=\//.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    gender TEXT DEFAULT '',
    country TEXT DEFAULT '',
    coins INTEGER NOT NULL DEFAULT 0,
    filters_until BIGINT NOT NULL DEFAULT 0,
    reports_received INTEGER NOT NULL DEFAULT 0,
    banned_until BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS coin_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    meta TEXT DEFAULT '',
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stripe_orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id TEXT UNIQUE NOT NULL,
    package_id TEXT NOT NULL,
    coins INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    reporter_id INTEGER NOT NULL,
    reported_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );`);
}

const now = () => Date.now();

async function getUser(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function addCoins(userId, delta, reason, meta = '') {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [delta, userId]);
    await c.query(
      'INSERT INTO coin_transactions (user_id, delta, reason, meta, created_at) VALUES ($1,$2,$3,$4,$5)',
      [userId, delta, reason, meta, now()]
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
  return r.rows[0].coins;
}

module.exports = { pool, init, now, getUser, addCoins };
