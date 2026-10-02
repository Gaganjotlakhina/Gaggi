// Assi20Tuc20 server: Express REST + WebSocket matchmaking/signaling + Stripe coins.
// Postgres-backed (DATABASE_URL). Run `npm start` after creating the database.
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const { pool, init, now, getUser, addCoins, transferCoins, chargeCallMinute, grantTester, createPromo, redeemPromo } = require('./db');

const PORT = process.env.PORT || 3000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

let stripe = null;
if (STRIPE_SECRET_KEY) stripe = require('stripe')(STRIPE_SECRET_KEY);

let googleClient = null;
if (process.env.GOOGLE_CLIENT_ID) {
  const { OAuth2Client } = require('google-auth-library');
  googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
}

const SIGNUP_BONUS = 100;
const FILTERS_24H_COST = 100;
const GIFT_CATALOG = [
  { emoji: '🌹', name: 'Rose', amount: 1 },
  { emoji: '☕', name: 'Coffee', amount: 5 },
  { emoji: '🍫', name: 'Chocolate', amount: 10 },
  { emoji: '🌸', name: 'Blossom', amount: 25 },
  { emoji: '💐', name: 'Bouquet', amount: 50 },
  { emoji: '🧸', name: 'Teddy', amount: 100 },
  { emoji: '🎁', name: 'Gift Box', amount: 250 },
  { emoji: '👑', name: 'Crown', amount: 500 },
  { emoji: '🚀', name: 'Rocket', amount: 1000 },
  { emoji: '🏎️', name: 'Sports Car', amount: 2500 },
  { emoji: '💎', name: 'Diamond', amount: 5000 },
];
const GIFT_AMOUNTS = GIFT_CATALOG.map((g) => g.amount);
const PACKAGES = {
  starter: { coins: 500, price_cents: 249, label: '500 Moon Coins' },
  popular: { coins: 1200, price_cents: 499, label: '1,200 Moon Coins' },
  whale: { coins: 3000, price_cents: 999, label: '3,000 Moon Coins' },
  bronze: { coins: 10000, price_cents: 2999, label: '10,000 Moon Coins' },
  silver: { coins: 25000, price_cents: 6999, label: '25,000 Moon Coins' },
  gold: { coins: 60000, price_cents: 14999, label: '60,000 Moon Coins' },
  platinum: { coins: 150000, price_cents: 34999, label: '150,000 Moon Coins' },
  diamond: { coins: 400000, price_cents: 89999, label: '400,000 Moon Coins' },
  mogul: { coins: 1000000, price_cents: 199999, label: '1,000,000 Moon Coins' },
  titan: { coins: 5500000, price_cents: 999999, label: '5,500,000 Moon Coins' },
};

// ---- per-minute call billing: 240 Moon Coins per started minute, charged only
// while the user is actually on a video call (never while waiting in queue) ----
const CALL_RATE = 240;
const CALL_MIN_MS = 60_000;

// ---- auth sessions (in-memory token -> userId) ----
const sessions = new Map();
const tokenFor = (userId) => {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, userId);
  return t;
};
const userIdFromReq = (req) => {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? sessions.get(m[1]) || null : null;
};

const app = express();

// Stripe webhook needs the raw body — register before express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).send('webhook not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('bad signature');
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const r = await pool.query('SELECT * FROM stripe_orders WHERE session_id = $1', [s.id]);
    const order = r.rows[0];
    if (order && order.status === 'pending') {
      await pool.query("UPDATE stripe_orders SET status = 'complete' WHERE id = $1", [order.id]);
      const balance = await addCoins(order.user_id, order.coins, 'purchase', s.id);
      pushCoins(order.user_id, balance);
    }
  }
  res.json({ ok: true });
});

app.use(express.json());
app.use(express.static('public'));
app.get('/health', (req, res) => res.send('ok'));

async function authz(req, res, next) {
  const id = userIdFromReq(req);
  if (!id) return res.status(401).json({ error: 'login required' });
  const u = await getUser(id);
  if (!u) return res.status(401).json({ error: 'login required' });
  if (u.banned_until > now()) return res.status(403).json({ error: 'account temporarily banned' });
  req.user = u;
  next();
}

const publicUser = (u) => ({
  id: u.id, username: u.username, gender: u.gender, country: u.country,
  coins: u.coins, filters_until: Number(u.filters_until), tester: !!u.tester,
});

// ---- auth ----
app.post('/api/register', async (req, res) => {
  const { username, password, gender = '', country = '' } = req.body || {};
  if (req.body?.age_ok !== true)
    return res.status(400).json({ error: 'You must confirm you are 18 or older.' });
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'username: 3-20 letters/numbers/_' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'password: min 6 characters' });
  const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (exists.rows[0]) return res.status(400).json({ error: 'username taken' });
  const hash = bcrypt.hashSync(password, 10);
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, gender, country, coins, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [username, hash, String(gender).slice(0, 20), String(country).slice(0, 40), SIGNUP_BONUS, now()]
  );
  const uid = r.rows[0].id;
  await pool.query(
    'INSERT INTO coin_transactions (user_id, delta, reason, created_at) VALUES ($1,$2,$3,$4)',
    [uid, SIGNUP_BONUS, 'signup_bonus', now()]
  );
  const u = await getUser(uid);
  res.json({ token: tokenFor(u.id), user: publicUser(u) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const u = r.rows[0];
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'bad username or password' });
  res.json({ token: tokenFor(u.id), user: publicUser(u) });
});

app.get('/api/me', authz, (req, res) => res.json({ user: publicUser(req.user) }));

// ---- social login (Google) ----
app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

async function findOrCreateOAuthUser(provider, sub, email) {
  const r = await pool.query('SELECT * FROM users WHERE oauth_provider = $1 AND oauth_sub = $2', [provider, sub]);
  if (r.rows[0]) return r.rows[0];
  let base = (String(email).split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 14) || 'user';
  if (base.length < 3) base = 'user' + base;
  let username = base, n = 0;
  while ((await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0]) {
    username = (base + (++n)).slice(0, 20);
  }
  const ins = await pool.query(
    'INSERT INTO users (username, password_hash, oauth_provider, oauth_sub, coins, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [username, 'oauth', provider, sub, SIGNUP_BONUS, now()]
  );
  await pool.query('INSERT INTO coin_transactions (user_id, delta, reason, created_at) VALUES ($1,$2,$3,$4)',
    [ins.rows[0].id, SIGNUP_BONUS, 'signup_bonus', now()]);
  return (await pool.query('SELECT * FROM users WHERE id = $1', [ins.rows[0].id])).rows[0];
}

app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Google login not configured' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: req.body.credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p.email_verified) return res.status(401).json({ error: 'email not verified' });
    const ex = await pool.query('SELECT id FROM users WHERE oauth_provider = $1 AND oauth_sub = $2', ['google', p.sub]);
    if (!ex.rows[0] && req.body?.age_ok !== true)
      return res.status(400).json({ error: 'You must confirm you are 18 or older.' });
    const u = await findOrCreateOAuthUser('google', p.sub, p.email);
    if (u.banned_until > now()) return res.status(403).json({ error: 'account temporarily banned' });
    res.json({ token: tokenFor(u.id), user: publicUser(u) });
  } catch (e) {
    res.status(401).json({ error: 'Google login failed' });
  }
});

// ---- coins ----
app.get('/api/coins/packages', (req, res) => {
  res.json({
    stripe_ready: !!stripe,
    packages: Object.entries(PACKAGES).map(([id, p]) => ({ id, ...p })),
    gift_amounts: GIFT_AMOUNTS,
    gifts: GIFT_CATALOG,
    filters_cost: FILTERS_24H_COST,
    signup_bonus: SIGNUP_BONUS,
  });
});

app.post('/api/coins/checkout', authz, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'payments not configured yet' });
  const pkg = PACKAGES[req.body.package_id];
  if (!pkg) return res.status(400).json({ error: 'unknown package' });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `${pkg.label} — Assi20Tuc20` },
        unit_amount: pkg.price_cents,
      },
      quantity: 1,
    }],
    success_url: `${APP_URL}/?coins=success`,
    cancel_url: `${APP_URL}/?coins=cancelled`,
    metadata: { user_id: String(req.user.id), package_id: req.body.package_id },
  });
  await pool.query(
    'INSERT INTO stripe_orders (user_id, session_id, package_id, coins, created_at) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, session.id, req.body.package_id, pkg.coins, now()]
  );
  res.json({ url: session.url });
});

app.post('/api/coins/unlock-filters', authz, async (req, res) => {
  const u = req.user;
  if (u.filters_until > now()) return res.json({ user: publicUser(u) });
  if (u.coins < FILTERS_24H_COST) return res.status(402).json({ error: 'not enough coins' });
  const balance = await addCoins(u.id, -FILTERS_24H_COST, 'filters_24h');
  await pool.query('UPDATE users SET filters_until = $1 WHERE id = $2', [now() + 24 * 3600 * 1000, u.id]);
  res.json({ user: publicUser(await getUser(u.id)), balance });
});

app.post('/api/report', authz, async (req, res) => {
  const reportedId = Number(req.body.reported_id);
  if (!reportedId || reportedId === req.user.id) return res.status(400).json({ error: 'bad report' });
  await pool.query('INSERT INTO reports (reporter_id, reported_id, reason, created_at) VALUES ($1,$2,$3,$4)',
    [req.user.id, reportedId, String(req.body.reason || '').slice(0, 200), now()]);
  const c = await pool.query('SELECT COUNT(*)::int AS c FROM reports WHERE reported_id = $1', [reportedId]);
  const tu = await pool.query('SELECT tester FROM users WHERE id = $1', [reportedId]);
  if (c.rows[0].c >= 5 && !tu.rows[0]?.tester) {
    await pool.query('UPDATE users SET banned_until = $1 WHERE id = $2', [now() + 24 * 3600 * 1000, reportedId]);
    dropUser(reportedId, 'banned');
  }
  res.json({ ok: true });
});

// Admin key check — ADMIN_KEY env var is set in the Render dashboard, never in the repo.
function adminOk(req) {
  const key = process.env.ADMIN_KEY || '';
  const given = String((req.body && req.body.admin_key) || '');
  if (!key || given.length !== key.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key)); }
  catch { return false; }
}

// Admin: promote an existing user to tester (unlimited coins, unlocked filters, ban-exempt).
app.post('/api/admin/grant', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    const u = await grantTester(username);
    res.json({ ok: true, user: publicUser(u) });
  } catch { res.status(404).json({ error: 'no such user' }); }
});

// Admin: create (or update) a promo code. Body: { admin_key, code, coins, max_uses? }
app.post('/api/admin/promo', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const p = await createPromo(req.body.code, req.body.coins, req.body.max_uses);
    res.json({ ok: true, promo: { code: p.code, coins: p.coins, max_uses: p.max_uses, used_count: p.used_count, active: p.active } });
  } catch (e) { res.status(400).json({ error: e.message || 'bad promo' }); }
});

// Redeem a promo code for bonus coins (one use per user per code).
app.post('/api/coins/redeem', authz, async (req, res) => {
  try {
    const r = await redeemPromo(req.user.id, req.body.code);
    pushCoins(req.user.id, r.balance);
    res.json({ ok: true, coins: r.coins, balance: r.balance });
  } catch (e) { res.status(400).json({ error: e.message || 'redeem failed' }); }
});

// ---- WebSocket: matchmaking + signaling ----
const wss = new WebSocketServer({ noServer: true });
const clients = new Map(); // userId -> ws
const waiting = [];        // [{userId, ws, filters}]
const rooms = new Map();   // roomId -> {a, b, timer} userIds + billing timer

function pushCoins(userId, balance) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'coins', balance }));
}

function dropUser(userId, reason) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'kicked', reason }));
  leaveQueue(userId);
  leaveRoom(userId);
}

function leaveQueue(userId) {
  const i = waiting.findIndex((w) => w.userId === userId);
  if (i >= 0) waiting.splice(i, 1);
}

function leaveRoom(userId) {
  for (const [roomId, r] of rooms) {
    if (r.a === userId || r.b === userId) {
      stopBilling(roomId);
      const peer = r.a === userId ? r.b : r.a;
      rooms.delete(roomId);
      const pws = clients.get(peer);
      if (pws && pws.readyState === 1) pws.send(JSON.stringify({ type: 'peer-left', roomId }));
    }
  }
}

// Charge one user for a started call minute. Testers (superusers) are exempt.
async function billUser(userId, roomId) {
  const u = await getUser(userId);
  if (!u) return { ok: false };
  if (u.tester) return { ok: true, free: true };
  try {
    const balance = await chargeCallMinute(userId, CALL_RATE, roomId);
    pushCoins(userId, balance);
    return { ok: true, balance };
  } catch {
    return { ok: false };
  }
}

function startBilling(roomId) {
  const r = rooms.get(roomId);
  if (!r || r.timer) return;
  r.timer = setInterval(async () => {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const uid of [room.a, room.b]) {
      const res = await billUser(uid, roomId);
      if (!res.ok) { endCallForBroke(roomId, uid); break; }
    }
  }, CALL_MIN_MS);
}

function stopBilling(roomId) {
  const r = rooms.get(roomId);
  if (r && r.timer) { clearInterval(r.timer); r.timer = null; }
}

// Someone ran out of Moon Coins mid-call: end it for both sides.
function endCallForBroke(roomId, brokeId) {
  const r = rooms.get(roomId);
  if (!r) return;
  stopBilling(roomId);
  const peer = r.a === brokeId ? r.b : r.a;
  rooms.delete(roomId);
  const bws = clients.get(brokeId), pws = clients.get(peer);
  if (bws && bws.readyState === 1) bws.send(JSON.stringify({ type: 'call-ended', reason: 'out-of-coins' }));
  if (pws && pws.readyState === 1) pws.send(JSON.stringify({ type: 'call-ended', reason: 'peer-out-of-coins' }));
}

const needsCoinsMsg = `You need at least ${CALL_RATE} Moon Coins for a minute of chat — tap Get Moon Coins.`;

const filtersOk = (mine, peerUser) => {
  if (mine.gender && peerUser.gender !== mine.gender) return false;
  if (mine.country && (peerUser.country || '').toLowerCase() !== mine.country.toLowerCase()) return false;
  return true;
};

async function tryMatch() {
  // Evict anyone who can't afford a minute (checked at queue time too, but
  // balances can change while waiting). No charge while waiting — only on call.
  for (let k = waiting.length - 1; k >= 0; k--) {
    const w = waiting[k];
    const u = await getUser(w.userId);
    if (u && !u.tester && u.coins < CALL_RATE) {
      waiting.splice(k, 1);
      try { w.ws.send(JSON.stringify({ type: 'error', error: needsCoinsMsg })); } catch {}
    }
  }
  for (let i = 0; i < waiting.length; i++) {
    for (let j = i + 1; j < waiting.length; j++) {
      const A = waiting[i], B = waiting[j];
      const uA = await getUser(A.userId), uB = await getUser(B.userId);
      if (!uA || !uB) continue;
      if (!filtersOk(A.filters, uB) || !filtersOk(B.filters, uA)) continue;
      // First minute is charged up front, before the call starts (testers exempt).
      const roomId = crypto.randomBytes(8).toString('hex');
      const ra = await billUser(A.userId, roomId);
      if (!ra.ok) {
        waiting.splice(i, 1);
        try { A.ws.send(JSON.stringify({ type: 'error', error: needsCoinsMsg })); } catch {}
        return;
      }
      const rb = await billUser(B.userId, roomId);
      if (!rb.ok) {
        if (!ra.free) { try { await addCoins(A.userId, CALL_RATE, 'call_minute_refund', `room:${roomId}`); } catch {} }
        waiting.splice(j, 1);
        try { B.ws.send(JSON.stringify({ type: 'error', error: needsCoinsMsg })); } catch {}
        return;
      }
      waiting.splice(j, 1); waiting.splice(i, 1);
      rooms.set(roomId, { a: A.userId, b: B.userId, timer: null });
      const peerA = { id: uB.id, username: uB.username, country: uB.country };
      const peerB = { id: uA.id, username: uA.username, country: uA.country };
      A.ws.send(JSON.stringify({ type: 'matched', roomId, peer: peerA, initiator: true }));
      B.ws.send(JSON.stringify({ type: 'matched', roomId, peer: peerB, initiator: false }));
      startBilling(roomId);
      return;
    }
  }
}

const BAD = ['nigga', 'nigger', 'faggot', 'kys'];
const clean = (t) => {
  let s = String(t || '').slice(0, 500);
  for (const w of BAD) s = s.replace(new RegExp(w, 'gi'), '****');
  return s;
};

wss.on('connection', (ws, req, userId) => {
  if (clients.has(userId)) { try { clients.get(userId).close(); } catch {} }
  clients.set(userId, ws);
  ws.userId = userId;

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const u = await getUser(userId);
    if (!u || u.banned_until > now()) { ws.send(JSON.stringify({ type: 'kicked', reason: 'banned' })); return; }

    if (m.type === 'queue') {
      leaveQueue(userId); leaveRoom(userId);
      const f = m.filters || {};
      const wantFilters = !!(f.gender || f.country);
      if (wantFilters && u.filters_until <= now()) {
        ws.send(JSON.stringify({ type: 'error', error: 'filters need unlocking (100 Moon Coins / 24h)' }));
        return;
      }
      if (!u.tester && u.coins < CALL_RATE) {
        ws.send(JSON.stringify({ type: 'error', error: needsCoinsMsg }));
        return;
      }
      waiting.push({ userId, ws, filters: { gender: f.gender || '', country: f.country || '' } });
      ws.send(JSON.stringify({ type: 'queued', waiting: waiting.length }));
      tryMatch();
    }
    else if (m.type === 'leave') { leaveQueue(userId); leaveRoom(userId); }
    else if (m.type === 'signal') {
      const r = rooms.get(m.roomId);
      if (!r) return;
      const peer = r.a === userId ? r.b : r.a;
      const pws = clients.get(peer);
      if (pws && pws.readyState === 1) pws.send(JSON.stringify({ type: 'signal', roomId: m.roomId, data: m.data }));
    }
    else if (m.type === 'chat') {
      const r = rooms.get(m.roomId);
      if (!r) return;
      const peer = r.a === userId ? r.b : r.a;
      const pws = clients.get(peer);
      if (pws && pws.readyState === 1)
        pws.send(JSON.stringify({ type: 'chat', roomId: m.roomId, from: u.username, text: clean(m.text) }));
    }
    else if (m.type === 'gift') {
      const amount = Number(m.amount);
      const gift = GIFT_CATALOG.find((g) => g.amount === amount);
      const r = rooms.get(m.roomId);
      if (!r || !gift) return;
      const peer = r.a === userId ? r.b : r.a;
      let balances;
      try {
        balances = await transferCoins(userId, peer, amount, `${gift.emoji} ${gift.name}`);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: e.message === 'not enough coins' ? 'not enough Moon Coins' : 'gift failed, no Moon Coins moved' }));
        return;
      }
      pushCoins(userId, balances.fromBalance);
      pushCoins(peer, balances.toBalance);
      const pws = clients.get(peer);
      if (pws && pws.readyState === 1)
        pws.send(JSON.stringify({ type: 'gift', roomId: m.roomId, from: u.username, amount, emoji: gift.emoji, name: gift.name }));
      ws.send(JSON.stringify({ type: 'gift-sent', amount, emoji: gift.emoji, name: gift.name }));
    }
  });

  ws.on('close', () => {
    if (clients.get(userId) === ws) clients.delete(userId);
    leaveQueue(userId); leaveRoom(userId);
  });
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  const m = (req.url || '').match(/token=([a-f0-9]{64})/);
  const userId = m ? sessions.get(m[1]) : null;
  if (!userId) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, userId));
});

init().then(() => {
  server.listen(PORT, () => console.log(`Assi20Tuc20 running at ${APP_URL}`));
}).catch((e) => { console.error('DB init failed:', e.message); process.exit(1); });
