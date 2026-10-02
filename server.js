// 1v1 video chat server: Express REST + WebSocket matchmaking/signaling + Stripe coins.
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const { db, now, addCoins } = require('./db');

const PORT = process.env.PORT || 3000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

let stripe = null;
if (STRIPE_SECRET_KEY) stripe = require('stripe')(STRIPE_SECRET_KEY);

const SIGNUP_BONUS = 100;
const FILTERS_24H_COST = 100;
const GIFT_AMOUNTS = [10, 25, 50, 100];
const PACKAGES = {
  starter: { coins: 500, price_cents: 499, label: '500 coins' },
  popular: { coins: 1200, price_cents: 999, label: '1,200 coins' },
  whale: { coins: 3000, price_cents: 1999, label: '3,000 coins' },
};

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
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

const app = express();

// Stripe webhook needs the raw body — register before express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).send('webhook not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('bad signature');
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const order = db.prepare('SELECT * FROM stripe_orders WHERE session_id = ?').get(s.id);
    if (order && order.status === 'pending') {
      db.prepare("UPDATE stripe_orders SET status = 'complete' WHERE id = ?").run(order.id);
      const balance = addCoins(order.user_id, order.coins, 'purchase', s.id);
      pushCoins(order.user_id, balance);
    }
  }
  res.json({ ok: true });
});

app.use(express.json());
app.use(express.static('public'));

function authz(req, res, next) {
  const id = userIdFromReq(req);
  if (!id) return res.status(401).json({ error: 'login required' });
  const u = getUser(id);
  if (!u) return res.status(401).json({ error: 'login required' });
  if (u.banned_until > now()) return res.status(403).json({ error: 'account temporarily banned' });
  req.user = u;
  next();
}

const publicUser = (u) => ({
  id: u.id, username: u.username, gender: u.gender, country: u.country,
  coins: u.coins, filters_until: u.filters_until,
});

// ---- auth ----
app.post('/api/register', (req, res) => {
  const { username, password, gender = '', country = '' } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'username: 3-20 letters/numbers/_' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'password: min 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
    return res.status(400).json({ error: 'username taken' });
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare(
    'INSERT INTO users (username, password_hash, gender, country, coins, created_at) VALUES (?,?,?,?,?,?)'
  ).run(username, hash, String(gender).slice(0, 20), String(country).slice(0, 40), SIGNUP_BONUS, now());
  db.prepare(
    'INSERT INTO coin_transactions (user_id, delta, reason, created_at) VALUES (?,?,?,?)'
  ).run(r.lastInsertRowid, SIGNUP_BONUS, 'signup_bonus', now());
  const u = getUser(r.lastInsertRowid);
  res.json({ token: tokenFor(u.id), user: publicUser(u) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'bad username or password' });
  res.json({ token: tokenFor(u.id), user: publicUser(u) });
});

app.get('/api/me', authz, (req, res) => res.json({ user: publicUser(req.user) }));

// ---- coins ----
app.get('/api/coins/packages', (req, res) => {
  res.json({
    stripe_ready: !!stripe,
    packages: Object.entries(PACKAGES).map(([id, p]) => ({ id, ...p })),
    gift_amounts: GIFT_AMOUNTS,
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
        product_data: { name: `${pkg.label} — 1v1 Chat` },
        unit_amount: pkg.price_cents,
      },
      quantity: 1,
    }],
    success_url: `${APP_URL}/?coins=success`,
    cancel_url: `${APP_URL}/?coins=cancelled`,
    metadata: { user_id: String(req.user.id), package_id: req.body.package_id },
  });
  db.prepare(
    'INSERT INTO stripe_orders (user_id, session_id, package_id, coins, created_at) VALUES (?,?,?,?,?)'
  ).run(req.user.id, session.id, req.body.package_id, pkg.coins, now());
  res.json({ url: session.url });
});

app.post('/api/coins/unlock-filters', authz, (req, res) => {
  const u = req.user;
  if (u.filters_until > now()) return res.json({ user: publicUser(u) });
  if (u.coins < FILTERS_24H_COST) return res.status(402).json({ error: 'not enough coins' });
  const balance = addCoins(u.id, -FILTERS_24H_COST, 'filters_24h');
  db.prepare('UPDATE users SET filters_until = ? WHERE id = ?').run(now() + 24 * 3600 * 1000, u.id);
  res.json({ user: publicUser(getUser(u.id)), balance });
});

app.post('/api/report', authz, (req, res) => {
  const reportedId = Number(req.body.reported_id);
  if (!reportedId || reportedId === req.user.id) return res.status(400).json({ error: 'bad report' });
  db.prepare('INSERT INTO reports (reporter_id, reported_id, reason, created_at) VALUES (?,?,?,?)')
    .run(req.user.id, reportedId, String(req.body.reason || '').slice(0, 200), now());
  const count = db.prepare('SELECT COUNT(*) c FROM reports WHERE reported_id = ?').get(reportedId).c;
  if (count >= 5) {
    db.prepare('UPDATE users SET banned_until = ? WHERE id = ?').run(now() + 24 * 3600 * 1000, reportedId);
    dropUser(reportedId, 'banned');
  }
  res.json({ ok: true });
});

// ---- WebSocket: matchmaking + signaling ----
const wss = new WebSocketServer({ noServer: true });
const clients = new Map(); // userId -> ws
const waiting = [];        // [{userId, ws, filters}]
const rooms = new Map();   // roomId -> {a, b} userIds

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
      const peer = r.a === userId ? r.b : r.a;
      rooms.delete(roomId);
      const pws = clients.get(peer);
      if (pws && pws.readyState === 1) pws.send(JSON.stringify({ type: 'peer-left', roomId }));
    }
  }
}

const filtersOk = (mine, peerUser) => {
  if (mine.gender && peerUser.gender !== mine.gender) return false;
  if (mine.country && (peerUser.country || '').toLowerCase() !== mine.country.toLowerCase()) return false;
  return true;
};

function tryMatch() {
  for (let i = 0; i < waiting.length; i++) {
    for (let j = i + 1; j < waiting.length; j++) {
      const A = waiting[i], B = waiting[j];
      const uA = getUser(A.userId), uB = getUser(B.userId);
      if (!uA || !uB) continue;
      if (!filtersOk(A.filters, uB) || !filtersOk(B.filters, uA)) continue;
      waiting.splice(j, 1); waiting.splice(i, 1);
      const roomId = crypto.randomBytes(8).toString('hex');
      rooms.set(roomId, { a: A.userId, b: B.userId });
      const peerA = { id: uB.id, username: uB.username, country: uB.country };
      const peerB = { id: uA.id, username: uA.username, country: uA.country };
      A.ws.send(JSON.stringify({ type: 'matched', roomId, peer: peerA, initiator: true }));
      B.ws.send(JSON.stringify({ type: 'matched', roomId, peer: peerB, initiator: false }));
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

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const u = getUser(userId);
    if (!u || u.banned_until > now()) { ws.send(JSON.stringify({ type: 'kicked', reason: 'banned' })); return; }

    if (m.type === 'queue') {
      leaveQueue(userId); leaveRoom(userId);
      const f = m.filters || {};
      const wantFilters = !!(f.gender || f.country);
      if (wantFilters && u.filters_until <= now()) {
        ws.send(JSON.stringify({ type: 'error', error: 'filters need unlocking (100 coins / 24h)' }));
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
      const r = rooms.get(m.roomId);
      if (!r || !GIFT_AMOUNTS.includes(amount)) return;
      const me = getUser(userId);
      if (me.coins < amount) { ws.send(JSON.stringify({ type: 'error', error: 'not enough coins' })); return; }
      const peer = r.a === userId ? r.b : r.a;
      addCoins(userId, -amount, 'gift_sent', `to:${peer}`);
      const peerBal = addCoins(peer, amount, 'gift_received', `from:${userId}`);
      pushCoins(userId, me.coins - amount);
      pushCoins(peer, peerBal);
      const pws = clients.get(peer);
      if (pws && pws.readyState === 1)
        pws.send(JSON.stringify({ type: 'gift', roomId: m.roomId, from: u.username, amount }));
      ws.send(JSON.stringify({ type: 'gift-sent', amount }));
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

server.listen(PORT, () => console.log(`1v1 chat running at ${APP_URL}`));
