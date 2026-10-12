// Live billing test: 100 Moon Coins/min charged only while on a video call.
// Flow: register payer+peer, redeem WELCOME500 each, match, verify balance drops
// 100 at match (minute 1) and another 100 at 60s (minute 2). Also verifies a
// fresh 100-coin user is accepted to the queue, and a 0-coin user is rejected.
const WebSocket = require('ws');

const BASE = 'https://assi20tuc20.com';
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  ? new (require('https-proxy-agent').HttpsProxyAgent)(process.env.HTTPS_PROXY || process.env.https_proxy)
  : undefined;

async function api(path, body, token, method = 'POST') {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (j.error) throw new Error(path + ' failed: ' + JSON.stringify(j));
  return j;
}
const me = (token) => api('/api/me', null, token, 'GET').then((j) => j.user.coins);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(prefix) {
  const u = prefix + Math.random().toString(36).slice(2, 8);
  const reg = await api('/api/register', { username: u, password: 'Test1234!', age_ok: true });
  return { name: u, token: reg.token };
}
function connect(token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(BASE.replace('https', 'wss') + '/ws?token=' + token, { agent: proxy });
    ws.once('open', () => res(ws));
    ws.once('error', rej);
  });
}
const waitFor = (ws, type, ms = 30000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), ms);
  const h = (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === type) { clearTimeout(t); ws.off('message', h); res(m); }
  };
  ws.on('message', h);
});

(async () => {
  // 1. deploy check
  const js = await fetch(BASE + '/app.js').then((r) => r.text());
  if (!js.includes('call-ended')) throw new Error('billing build not live yet');
  console.log('deploy live ✓');

  // 2. payer + peer, 600 coins each (100 signup + 500 promo)
  const A = await makeUser('billA_');
  const B = await makeUser('billB_');
  await api('/api/coins/redeem', { code: 'WELCOME500' }, A.token);
  await api('/api/coins/redeem', { code: 'WELCOME500' }, B.token);
  console.log('A start:', await me(A.token), '| B start:', await me(B.token));

  // 3. queue both, wait for match
  const wsA = await connect(A.token);
  const wsB = await connect(B.token);
  const matchP = waitFor(wsA, 'matched');
  wsA.send(JSON.stringify({ type: 'queue', filters: {} }));
  wsB.send(JSON.stringify({ type: 'queue', filters: {} }));
  await matchP;
  console.log('matched ✓');
  await sleep(2500);
  const a1 = await me(A.token), b1 = await me(B.token);
  console.log(`after minute-1 charge: A=${a1} (want 500) B=${b1} (want 500)`);
  if (a1 !== 500 || b1 !== 500) throw new Error('minute-1 charge wrong');

  // 4. wait past the 60s tick
  await sleep(65000);
  const a2 = await me(A.token), b2 = await me(B.token);
  console.log(`after minute-2 charge: A=${a2} (want 400) B=${b2} (want 400)`);
  if (a2 !== 400 || b2 !== 400) throw new Error('minute-2 charge wrong');

  // 5. end call, make sure billing stopped (no further charges)
  wsA.send(JSON.stringify({ type: 'leave' }));
  wsB.send(JSON.stringify({ type: 'leave' }));
  await sleep(3000);
  const a3 = await me(A.token);
  console.log(`after leave: A=${a3} (want 400, no more charges)`);
  if (a3 !== 400) throw new Error('charged after call ended!');
  wsA.close(); wsB.close();

  // 6. fresh 100-coin user is ACCEPTED to the queue (new 100 minimum)
  const C = await makeUser('billC_');
  const wsC = await connect(C.token);
  const qP = waitFor(wsC, 'queued');
  wsC.send(JSON.stringify({ type: 'queue', filters: {} }));
  await qP;
  console.log('100-coin user accepted to queue ✓');

  // 7. broke user (0 coins after one matched minute) must be rejected from queue
  const D = await makeUser('billD_');
  const wsD = await connect(D.token);
  const mP = waitFor(wsD, 'matched');
  wsD.send(JSON.stringify({ type: 'queue', filters: {} }));
  await mP;
  console.log('C+D matched ✓ (minute-1 charged)');
  await sleep(2500);
  const c0 = await me(C.token);
  console.log(`C balance after match: ${c0} (want 0)`);
  if (c0 !== 0) throw new Error('minute-1 charge wrong for C');
  wsC.send(JSON.stringify({ type: 'leave' }));
  wsD.send(JSON.stringify({ type: 'leave' }));
  await sleep(2000);
  const errP = waitFor(wsC, 'error');
  wsC.send(JSON.stringify({ type: 'queue', filters: {} }));
  const err = await errP;
  console.log('broke user rejected ✓:', err.error);
  if (!/100/.test(err.error)) throw new Error('wrong rejection message');
  wsC.close(); wsD.close();

  console.log('ALL BILLING TESTS PASSED ✓');
  process.exit(0);
})().catch((e) => { console.error('BILLING TEST FAILED:', e.message); process.exit(1); });
