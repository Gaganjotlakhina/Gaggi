// Assi20Tuc20 client: auth, matchmaking, WebRTC, coins.
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'request failed');
  return j;
};

const state = { token: localStorage.getItem('tassi20'), user: null, ws: null, roomId: null, peer: null, pc: null, local: null, mode: 'login' };

// ---------- auth ----------
function paintAuth() {
  $('coinPill').classList.toggle('hidden', !state.user);
  $('shopBtn').classList.toggle('hidden', !state.user);
  $('authBtn').textContent = state.user ? state.user.username + ' · out' : 'Log in';
  $('filterRow').classList.toggle('hidden', !state.user);
  if (state.user) {
    $('coinBal').textContent = state.user.coins;
    $('unlockBtn').textContent = state.user.filters_until > Date.now()
      ? '✓ Filters active' : 'Unlock filters 🪙100/24h';
  }
}
async function refreshMe() {
  try { const { user } = await api('/api/me'); state.user = user; } catch { state.user = null; state.token = null; localStorage.removeItem('tassi20'); }
  paintAuth();
}
$('authBtn').onclick = () => {
  if (state.user) { state.token = null; localStorage.removeItem('tassi20'); state.user = null; paintAuth(); return; }
  $('authModal').classList.remove('hidden');
};
$('authSwap').onclick = (e) => {
  e.preventDefault();
  state.mode = state.mode === 'login' ? 'register' : 'login';
  $('authTitle').textContent = state.mode === 'login' ? 'Log in' : 'Register';
  $('authSwap').textContent = state.mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in';
  $('regExtra').classList.toggle('hidden', state.mode === 'login');
};
$('authClose').onclick = (e) => { e.preventDefault(); $('authModal').classList.add('hidden'); };
$('authGo').onclick = async () => {
  $('authErr').textContent = '';
  try {
    const body = { username: $('aUser').value.trim(), password: $('aPass').value };
    if (state.mode === 'register') { body.gender = $('aGender').value; body.country = $('aCountry').value.trim(); }
    const j = await api(state.mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
    state.token = j.token; localStorage.setItem('tassi20', j.token); state.user = j.user;
    $('authModal').classList.add('hidden'); paintAuth();
    sys(`Welcome, ${j.user.username}! +100 🪙 signup bonus`);
  } catch (e) { $('authErr').textContent = e.message; }
};

// ---------- coin shop ----------
$('shopBtn').onclick = async () => {
  $('shopModal').classList.remove('hidden');
  const { packages, stripe_ready } = await api('/api/coins/packages');
  $('pkgs').innerHTML = packages.map(p =>
    `<div class="pkg"><span>🪙 ${p.label}</span><button class="btn small" data-p="${p.id}" ${stripe_ready ? '' : 'disabled'}>$${(p.price_cents / 100).toFixed(2)}</button></div>`
  ).join('') + (stripe_ready ? '' : '<p class="fine">Payments not connected yet — ask the site owner.</p>');
  $('pkgs').querySelectorAll('button[data-p]').forEach(b => b.onclick = async () => {
    try { const { url } = await api('/api/coins/checkout', { method: 'POST', body: { package_id: b.dataset.p } }); location.href = url; }
    catch (e) { $('shopErr').textContent = e.message; }
  });
};
$('shopClose').onclick = (e) => { e.preventDefault(); $('shopModal').classList.add('hidden'); };
$('unlockBtn').onclick = async () => {
  try { const { user } = await api('/api/coins/unlock-filters', { method: 'POST' }); state.user = user; paintAuth(); }
  catch (e) { alert(e.message); }
};

// ---------- chat ----------
function sys(t) { const d = document.createElement('div'); d.className = 'sys'; d.textContent = t; $('msgs').appendChild(d); $('msgs').scrollTop = 1e6; }
function showView(name) { $('landing').classList.toggle('hidden', name !== 'landing'); $('chat').classList.toggle('hidden', name !== 'chat'); }

const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

async function startChat() {
  if (!state.user) { $('authModal').classList.remove('hidden'); return; }
  try {
    state.local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch { alert('Camera + mic needed for video chat.'); return; }
  $('localV').srcObject = state.local;
  showView('chat'); $('msgs').innerHTML = '';
  connectWS();
}
$('startBtn').onclick = startChat;

function connectWS() {
  if (state.ws) try { state.ws.close(); } catch {}
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${state.token}`);
  state.ws = ws;
  ws.onopen = () => {
    setStatus('Finding someone…');
    ws.send(JSON.stringify({ type: 'queue', filters: { gender: $('fGender').value, country: $('fCountry').value.trim() } }));
  };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'queued') setStatus(`Waiting… (${m.waiting} in queue)`);
    else if (m.type === 'matched') onMatched(m);
    else if (m.type === 'signal') onSignal(m.data);
    else if (m.type === 'chat') addMsg(m.from, m.text);
    else if (m.type === 'gift') { giftMsg(`${m.from} sent you 🪙${m.amount}!`); }
    else if (m.type === 'gift-sent') giftMsg(`You sent 🪙${m.amount}`);
    else if (m.type === 'peer-left') { sys('Stranger left.'); cleanupPeer(); setStatus('Finding someone new…'); ws.send(JSON.stringify({ type: 'queue', filters: curFilters() })); }
    else if (m.type === 'coins') { state.user.coins = m.balance; paintAuth(); }
    else if (m.type === 'error') { setStatus('⚠ ' + m.error); }
    else if (m.type === 'kicked') { alert('Kicked: ' + m.reason); stopAll(); }
  };
  ws.onclose = () => setStatus('Disconnected.');
}
const curFilters = () => ({ gender: $('fGender').value, country: $('fCountry').value.trim() });
function setStatus(t) { $('status').textContent = t; }
function addMsg(from, text) { const d = document.createElement('div'); d.className = 'm'; d.innerHTML = ''; d.appendChild(Object.assign(document.createElement('b'), { textContent: from + ': ' })); d.appendChild(document.createTextNode(text)); $('msgs').appendChild(d); $('msgs').scrollTop = 1e6; }
function giftMsg(t) { const d = document.createElement('div'); d.className = 'giftm'; d.textContent = t; $('msgs').appendChild(d); $('msgs').scrollTop = 1e6; }

async function onMatched(m) {
  state.roomId = m.roomId; state.peer = m.peer;
  $('peerName').textContent = m.peer.username + (m.peer.country ? ' · ' + m.peer.country : '');
  setStatus('Connected — say hi! 👋');
  sys(`You're chatting with ${m.peer.username}`);
  cleanupPeer();
  const pc = new RTCPeerConnection(RTC_CFG);
  state.pc = pc;
  state.local.getTracks().forEach(t => pc.addTrack(t, state.local));
  pc.ontrack = (e) => { $('remoteV').srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => { if (e.candidate) state.ws.send(JSON.stringify({ type: 'signal', roomId: state.roomId, data: { candidate: e.candidate } })); };
  if (m.initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.ws.send(JSON.stringify({ type: 'signal', roomId: state.roomId, data: { sdp: pc.localDescription } }));
  }
}
async function onSignal(d) {
  const pc = state.pc; if (!pc) return;
  if (d.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
    if (d.sdp.type === 'offer') {
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      state.ws.send(JSON.stringify({ type: 'signal', roomId: state.roomId, data: { sdp: pc.localDescription } }));
    }
  } else if (d.candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch {} }
}
function cleanupPeer() { try { state.pc && state.pc.close(); } catch {} state.pc = null; $('remoteV').srcObject = null; }

$('sendBtn').onclick = sendChat;
$('chatIn').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
function sendChat() {
  const t = $('chatIn').value.trim();
  if (!t || !state.roomId) return;
  state.ws.send(JSON.stringify({ type: 'chat', roomId: state.roomId, text: t }));
  addMsg('You', t); $('chatIn').value = '';
}
$('nextBtn').onclick = () => { if (!state.ws) return; cleanupPeer(); setStatus('Finding someone…'); state.ws.send(JSON.stringify({ type: 'leave' })); state.ws.send(JSON.stringify({ type: 'queue', filters: curFilters() })); };
$('stopBtn').onclick = stopAll;
function stopAll() {
  try { state.ws && state.ws.send(JSON.stringify({ type: 'leave' })); state.ws && state.ws.close(); } catch {}
  cleanupPeer();
  try { state.local && state.local.getTracks().forEach(t => t.stop()); } catch {}
  state.local = null; showView('landing');
}
$('reportBtn').onclick = async () => {
  if (!state.peer) return;
  if (!confirm(`Report ${state.peer.username}?`)) return;
  await api('/api/report', { method: 'POST', body: { reported_id: state.peer.id, reason: 'reported from chat' } });
  sys('Reported. Finding someone new…'); $('nextBtn').click();
};
$('giftBtn').onclick = async () => {
  if (!state.peer) return;
  const { gift_amounts } = await api('/api/coins/packages');
  $('giftBtns').innerHTML = gift_amounts.map(a => `<button class="btn" data-a="${a}">🪙${a}</button>`).join('');
  $('giftBtns').querySelectorAll('button').forEach(b => b.onclick = () => {
    state.ws.send(JSON.stringify({ type: 'gift', roomId: state.roomId, amount: Number(b.dataset.a) }));
    $('giftModal').classList.add('hidden');
  });
  $('giftModal').classList.remove('hidden');
};
$('giftClose').onclick = (e) => { e.preventDefault(); $('giftModal').classList.add('hidden'); };

// ---------- init ----------
(async () => {
  await refreshMe();
  if (new URLSearchParams(location.search).get('coins') === 'success') { await refreshMe(); sys(''); alert('Coins added! 🪙'); history.replaceState({}, '', '/'); }
})();
