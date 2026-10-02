// SQLite schema + helpers for the 1v1 chat app (uses Node's built-in node:sqlite).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'app.db'));
db.exec(`PRAGMA journal_mode = WAL;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  gender TEXT DEFAULT '',
  country TEXT DEFAULT '',
  coins INTEGER NOT NULL DEFAULT 0,
  filters_until INTEGER NOT NULL DEFAULT 0,
  reports_received INTEGER NOT NULL DEFAULT 0,
  banned_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  meta TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id TEXT UNIQUE NOT NULL,
  package_id TEXT NOT NULL,
  coins INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  reported_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const now = () => Date.now();

function addCoins(userId, delta, reason, meta = '') {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(delta, userId);
    db.prepare(
      'INSERT INTO coin_transactions (user_id, delta, reason, meta, created_at) VALUES (?,?,?,?,?)'
    ).run(userId, delta, reason, meta, now());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT coins FROM users WHERE id = ?').get(userId).coins;
}

module.exports = { db, now, addCoins };
