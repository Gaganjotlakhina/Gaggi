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
  // OAuth columns (added after launch — safe to re-run)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_sub TEXT DEFAULT ''`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth ON users (oauth_provider, oauth_sub) WHERE oauth_provider <> ''`);
  // Tester accounts: unlimited coins, unlocked filters, ban-exempt (safe to re-run)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tester BOOLEAN NOT NULL DEFAULT FALSE`);
  // Promo codes (safe to re-run)
  await pool.query(`CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY,
    coins INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS promo_redemptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE(user_id, code)
  )`);
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

// Atomic coin transfer: debits sender and credits receiver in ONE transaction,
// so a gift can never vanish halfway (no lost coins on failure).
async function transferCoins(fromId, toId, amount, giftLabel = '') {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('bad amount');
  if (fromId === toId) throw new Error('cannot gift yourself');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Lock both rows in id order to avoid deadlocks under concurrency.
    const ids = [fromId, toId].sort((a, b) => a - b);
    const r = await c.query('SELECT id, coins FROM users WHERE id = ANY($1) ORDER BY id', [ids]);
    if (r.rows.length !== 2) throw new Error('user not found');
    const bal = Object.fromEntries(r.rows.map((x) => [x.id, x.coins]));
    if (bal[fromId] < amount) throw new Error('not enough coins');
    await c.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [amount, fromId]);
    await c.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [amount, toId]);
    const t = now();
    await c.query(
      'INSERT INTO coin_transactions (user_id, delta, reason, meta, created_at) VALUES ($1,$2,$3,$4,$5)',
      [fromId, -amount, 'gift_sent', `${giftLabel} to:${toId}`, t]
    );
    await c.query(
      'INSERT INTO coin_transactions (user_id, delta, reason, meta, created_at) VALUES ($1,$2,$3,$4,$5)',
      [toId, amount, 'gift_received', `${giftLabel} from:${fromId}`, t]
    );
    await c.query('COMMIT');
    return { fromBalance: bal[fromId] - amount, toBalance: bal[toId] + amount };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, init, now, getUser, addCoins, transferCoins, grantTester, createPromo, redeemPromo };

async function createPromo(code, coins, maxUses) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,24}$/.test(code)) throw new Error('bad code format');
  coins = Math.max(0, Math.floor(Number(coins) || 0));
  maxUses = maxUses == null || maxUses === '' ? null : Math.max(1, Math.floor(Number(maxUses)));
  await pool.query(
    `INSERT INTO promo_codes (code, coins, max_uses, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO UPDATE SET coins = EXCLUDED.coins, max_uses = EXCLUDED.max_uses, active = TRUE`,
    [code, coins, maxUses, Date.now()]
  );
  const r = await pool.query('SELECT * FROM promo_codes WHERE code = $1', [code]);
  return r.rows[0];
}

// Atomically redeem a promo code for a user: validates, grants coins, records use.
// Throws with a human-readable message on any failure.
async function redeemPromo(userId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('SELECT * FROM promo_codes WHERE code = $1 FOR UPDATE', [code]);
    const p = r.rows[0];
    if (!p) throw new Error('Invalid promo code.');
    if (!p.active) throw new Error('This promo code is no longer active.');
    if (p.max_uses != null && p.used_count >= p.max_uses) throw new Error('This promo code has run out.');
    const already = await c.query('SELECT 1 FROM promo_redemptions WHERE user_id = $1 AND code = $2', [userId, code]);
    if (already.rows[0]) throw new Error('You already used this code.');
    await c.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [p.coins, userId]);
    await c.query(
      'INSERT INTO coin_transactions (user_id, delta, reason, meta, created_at) VALUES ($1,$2,$3,$4,$5)',
      [userId, p.coins, 'promo', code, Date.now()]
    );
    await c.query('INSERT INTO promo_redemptions (user_id, code, created_at) VALUES ($1,$2,$3)', [userId, code, Date.now()]);
    await c.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1', [code]);
    await c.query('COMMIT');
    const bal = await c.query('SELECT coins FROM users WHERE id = $1', [userId]);
    return { coins: p.coins, balance: bal.rows[0].coins };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function grantTester(username) {
  const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const u = r.rows[0];
  if (!u) throw new Error('no such user');
  const farFuture = Date.now() + 10 * 365 * 24 * 3600 * 1000; // ~10 years
  await pool.query('UPDATE users SET coins = $1, filters_until = $2, tester = TRUE, banned_until = 0 WHERE id = $3',
    [999999, farFuture, u.id]);
  await pool.query(
    'INSERT INTO coin_transactions (user_id, delta, reason, meta, created_at) VALUES ($1, $2, $3, $4, $5)',
    [u.id, 999999 - u.coins, 'admin_grant', 'tester account', Date.now()]);
  return getUser(u.id);
}
