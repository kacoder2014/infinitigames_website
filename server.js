const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { WebSocketServer } = require('ws');

const PORT       = process.env.PORT || 3000;
const USERS_FILE   = path.join(__dirname, 'users.json');
const FRIENDS_FILE = path.join(__dirname, 'friends.json');

// ── User store ────────────────────────────────────────────────
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}

let savePending = false;
function saveUsers() {
  if (savePending) return;
  savePending = true;
  setImmediate(() => { fs.writeFile(USERS_FILE, JSON.stringify(users), () => { savePending = false; }); });
}

// ── Friends store  { username → { friends:[], incoming:[], outgoing:[] } } ──
let friendsData = {};
try { friendsData = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8')); } catch {}

function saveFriends() {
  fs.writeFile(FRIENDS_FILE, JSON.stringify(friendsData), () => {});
}
function getFD(username) {
  if (!friendsData[username]) friendsData[username] = { friends: [], incoming: [], outgoing: [] };
  return friendsData[username];
}
// Resolve any casing of a username to its registered canonical form.
// Returns null if the user doesn't exist.
function canonicalUser(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return users[key] ? users[key].username : null;
}

// ── Sessions ──────────────────────────────────────────────────
const sessions = new Map();
function genToken()             { return crypto.randomBytes(32).toString('hex'); }
function hashPw(password, salt) { return crypto.createHash('sha256').update(salt + password).digest('hex'); }

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}
function sessionUser(req) {
  const { igSession } = parseCookies(req.headers.cookie);
  return igSession ? (sessions.get(igSession) || null) : null;
}

// ── HTTP helpers ──────────────────────────────────────────────
const MIME = {
  '.html':'text/html', '.htm':'text/html', '.css':'text/css',
  '.js':'application/javascript', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf',
  '.mp3':'audio/mpeg', '.mp4':'video/mp4',
};
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function setCookie(res, token) {
  res.setHeader('Set-Cookie', `igSession=${token}; Path=/; Max-Age=${60*60*24*30}; HttpOnly; SameSite=Strict`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'igSession=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
}
function readBody(req) {
  return new Promise(res => {
    let raw = '';
    req.on('data', d => raw += d);
    req.on('end', () => { try { res(JSON.parse(raw)); } catch { res({}); } });
  });
}
function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/html'}); return res.end('<h1>404</h1>'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── WS helpers ────────────────────────────────────────────────
const clients = new Map(); // ws → { username, game }

function sendTo(username, data) {
  const key = username.toLowerCase();
  const msg = JSON.stringify(data);
  for (const [ws, c] of clients)
    if (c.username && c.username.toLowerCase() === key && ws.readyState === ws.OPEN) ws.send(msg);
}

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  for (const [ws] of clients)
    if (ws !== excludeWs && ws.readyState === ws.OPEN) ws.send(msg);
}
function broadcastAll(data) { broadcast(data, null); }
function onlineCount()      { return clients.size; }

function isOnline(username) {
  const key = username.toLowerCase();
  for (const [ws, c] of clients)
    if (c.username && c.username.toLowerCase() === key && ws.readyState === ws.OPEN) return true;
  return false;
}
function getGame(username) {
  const key = username.toLowerCase();
  for (const [ws, c] of clients)
    if (c.username && c.username.toLowerCase() === key && ws.readyState === ws.OPEN) return c.game || null;
  return null;
}

function notifyFriendsPresence(username, online, game = null) {
  const fd = getFD(username);
  fd.friends.forEach(f => sendTo(f, { type: 'friend_presence', username, online, game }));
}

function buildFriendsList(username) {
  return getFD(username).friends.map(f => ({
    username: f,
    online:   isOnline(f),
    game:     getGame(f),
  }));
}

// ── HTTP server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url.startsWith('/api/')) {

    // ── Auth ──
    if (url === '/api/me' && req.method === 'GET') {
      const username = sessionUser(req);
      if (!username) return json(res, 401, { error: 'Not logged in' });
      return json(res, 200, { username });
    }

    if (url === '/api/register' && req.method === 'POST') {
      const { username = '', password = '' } = await readBody(req);
      const u = username.trim(), p = password;
      if (!u || !p)                        return json(res, 400, { error: 'Username and password are required.' });
      if (u.length < 3)                    return json(res, 400, { error: 'Username must be at least 3 characters.' });
      if (p.length < 4)                    return json(res, 400, { error: 'Password must be at least 4 characters.' });
      if (!/^[a-zA-Z0-9_]+$/.test(u))     return json(res, 400, { error: 'Letters, numbers and _ only.' });
      if (users[u.toLowerCase()])          return json(res, 409, { error: 'Username already taken.' });
      const salt = crypto.randomBytes(16).toString('hex');
      users[u.toLowerCase()] = { username: u, hash: hashPw(p, salt), salt };
      saveUsers();
      const token = genToken();
      sessions.set(token, u);
      setCookie(res, token);
      return json(res, 200, { username: u });
    }

    if (url === '/api/login' && req.method === 'POST') {
      const { username = '', password = '' } = await readBody(req);
      const record = users[username.trim().toLowerCase()];
      if (!record || hashPw(password, record.salt) !== record.hash)
        return json(res, 401, { error: 'Incorrect username or password.' });
      const token = genToken();
      sessions.set(token, record.username);
      setCookie(res, token);
      return json(res, 200, { username: record.username });
    }

    if (url === '/api/logout' && req.method === 'POST') {
      const { igSession } = parseCookies(req.headers.cookie);
      if (igSession) sessions.delete(igSession);
      clearCookie(res);
      return json(res, 200, { ok: true });
    }

    // ── Friends ──
    if (url === '/api/friends' && req.method === 'GET') {
      const username = sessionUser(req);
      if (!username) return json(res, 401, { error: 'Not logged in' });
      const fd = getFD(username);
      return json(res, 200, {
        friends:  buildFriendsList(username),
        incoming: fd.incoming,
        outgoing: fd.outgoing,
      });
    }

    if (url === '/api/friends/request' && req.method === 'POST') {
      const username = sessionUser(req);
      if (!username) return json(res, 401, { error: 'Not logged in' });
      const { to = '' } = await readBody(req);
      const toKey = to.trim().toLowerCase();
      if (!toKey) return json(res, 400, { error: 'Enter a username.' });
      if (toKey === username.toLowerCase()) return json(res, 400, { error: 'You can\'t friend yourself.' });
      const record = users[toKey];
      if (!record) return json(res, 404, { error: 'Player not found.' });
      const target = record.username;
      const myFD = getFD(username), theirFD = getFD(target);

      const tLow = target.toLowerCase();
      if (myFD.friends.some(u => u.toLowerCase() === tLow))   return json(res, 400, { error: 'Already friends.' });
      if (myFD.outgoing.some(u => u.toLowerCase() === tLow))  return json(res, 400, { error: 'Request already sent.' });

      // They already sent us one → auto-accept
      if (myFD.incoming.some(u => u.toLowerCase() === tLow)) {
        const uLow = username.toLowerCase();
        if (!myFD.friends.some(u => u.toLowerCase() === tLow))   myFD.friends.push(target);
        if (!theirFD.friends.some(u => u.toLowerCase() === uLow)) theirFD.friends.push(username);
        myFD.incoming    = myFD.incoming.filter(u => u.toLowerCase() !== tLow);
        theirFD.outgoing = theirFD.outgoing.filter(u => u.toLowerCase() !== uLow);
        saveFriends();
        sendTo(target, { type: 'friend_accepted', from: username, friends: buildFriendsList(target) });
        return json(res, 200, { ok: true, autoAccepted: true });
      }

      myFD.outgoing.push(target);
      theirFD.incoming.push(username);
      saveFriends();
      sendTo(target, { type: 'friend_request', from: username });
      return json(res, 200, { ok: true });
    }

    if (url === '/api/friends/respond' && req.method === 'POST') {
      const username = sessionUser(req);
      if (!username) return json(res, 401, { error: 'Not logged in' });
      const { from: fromRaw = '', accept = false } = await readBody(req);
      const from = canonicalUser(fromRaw);
      if (!from) return json(res, 404, { error: 'Player not found.' });
      if (from.toLowerCase() === username.toLowerCase()) return json(res, 400, { error: 'Invalid request.' });
      const myFD = getFD(username), theirFD = getFD(from);
      const uLow = username.toLowerCase(), fLow = from.toLowerCase();
      myFD.incoming    = myFD.incoming.filter(u => u.toLowerCase() !== fLow);
      theirFD.outgoing = theirFD.outgoing.filter(u => u.toLowerCase() !== uLow);
      if (accept) {
        if (!myFD.friends.some(u => u.toLowerCase() === fLow))   myFD.friends.push(from);
        if (!theirFD.friends.some(u => u.toLowerCase() === uLow)) theirFD.friends.push(username);
        sendTo(from, { type: 'friend_accepted', from: username, friends: buildFriendsList(from) });
        sendTo(from,     { type: 'friend_presence', username, online: isOnline(username), game: getGame(username) });
        sendTo(username, { type: 'friend_presence', username: from, online: isOnline(from), game: getGame(from) });
      }
      saveFriends();
      return json(res, 200, { ok: true });
    }

    if (url === '/api/friends/remove' && req.method === 'POST') {
      const username = sessionUser(req);
      if (!username) return json(res, 401, { error: 'Not logged in' });
      const { username: targetRaw = '' } = await readBody(req);
      const target = canonicalUser(targetRaw);
      if (!target) return json(res, 200, { ok: true }); // already gone, no-op
      const myFD = getFD(username), theirFD = getFD(target);
      const uLow = username.toLowerCase(), tLow = target.toLowerCase();
      myFD.friends    = myFD.friends.filter(u => u.toLowerCase() !== tLow);
      theirFD.friends = theirFD.friends.filter(u => u.toLowerCase() !== uLow);
      saveFriends();
      return json(res, 200, { ok: true });
    }

    // ── Presence ──
    if (url === '/api/presence' && req.method === 'POST') {
      const username = sessionUser(req);
      if (!username) return json(res, 200, { ok: true });
      const { game = null } = await readBody(req);
      const uLow = username.toLowerCase();
      for (const [, c] of clients) if (c.username && c.username.toLowerCase() === uLow) c.game = game;
      notifyFriendsPresence(username, true, game);
      return json(res, 200, { ok: true });
    }

    // ── Admin ──
    if (url === '/api/admin/users' && req.method === 'GET') {
      const username = sessionUser(req);
      if (!username || username.toLowerCase() !== 'karan') return json(res, 403, { error: 'Forbidden' });
      const list = Object.values(users).map(u => ({
        username: u.username,
        online:   isOnline(u.username),
      })).sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
      return json(res, 200, { users: list });
    }

    if (url === '/api/admin/delete-user' && req.method === 'POST') {
      const username = sessionUser(req);
      if (!username || username.toLowerCase() !== 'karan') return json(res, 403, { error: 'Forbidden' });
      const { username: targetRaw = '' } = await readBody(req);
      const target = canonicalUser(targetRaw);
      if (!target) return json(res, 404, { error: 'User not found.' });
      if (target.toLowerCase() === 'karan') return json(res, 400, { error: 'Cannot delete admin.' });

      // Remove from users store
      delete users[target.toLowerCase()];
      saveUsers();

      // Remove all active sessions for this user
      for (const [token, u] of sessions) if (u.toLowerCase() === target.toLowerCase()) sessions.delete(token);

      // Disconnect their WS connections
      const tLow = target.toLowerCase();
      for (const [ws, c] of clients) if (c.username && c.username.toLowerCase() === tLow) ws.close();

      // Remove from friends data
      const tFD = friendsData[target];
      if (tFD) {
        // Remove target from everyone else's lists
        for (const [user, fd] of Object.entries(friendsData)) {
          fd.friends  = fd.friends.filter(u => u.toLowerCase() !== tLow);
          fd.incoming = fd.incoming.filter(u => u.toLowerCase() !== tLow);
          fd.outgoing = fd.outgoing.filter(u => u.toLowerCase() !== tLow);
        }
        delete friendsData[target];
      }
      saveFriends();

      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'Unknown API route' });
  }

  // ── Static files ──
  let filePath = path.join(__dirname, url === '/' ? '/index.html' : url);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) return serveFile(path.join(filePath, 'index.html'), res);
    serveFile(filePath, res);
  });
});

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const username = sessionUser(req);
  clients.set(ws, { username, game: null });

  if (username) {
    ws.send(JSON.stringify({ type: 'joined', username, online: onlineCount() }));
    broadcast({ type: 'system', text: `${username} joined the chat`, online: onlineCount() }, ws);
    // Tell this user about their friends' presence
    const friends = buildFriendsList(username);
    if (friends.length) ws.send(JSON.stringify({ type: 'friends_update', friends }));
    // Notify friends this user is now online
    notifyFriendsPresence(username, true, null);
  } else {
    ws.send(JSON.stringify({ type: 'auth_required' }));
  }

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);

    if (msg.type === 'join') {
      if (msg.username) {
        // Resolve to the canonical casing stored in users, fallback to what was sent
        const key = String(msg.username).trim().toLowerCase();
        const canonical = users[key] ? users[key].username : String(msg.username).trim().slice(0, 24);
        const wasUnknown = !client.username;
        client.username = canonical;
        if (wasUnknown) {
          ws.send(JSON.stringify({ type: 'joined', username: canonical, online: onlineCount() }));
          broadcast({ type: 'system', text: `${canonical} joined the chat`, online: onlineCount() }, ws);
        }
        const friends = buildFriendsList(canonical);
        if (friends.length) ws.send(JSON.stringify({ type: 'friends_update', friends }));
        notifyFriendsPresence(canonical, true, null);
      }
      return;
    }

    if (msg.type === 'message') {
      if (!client?.username) return;
      const text = String(msg.text || '').trim().slice(0, 500);
      if (!text) return;
      broadcastAll({
        type: 'message', username: client.username, text,
        time: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
        online: onlineCount(),
      });
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    clients.delete(ws);
    if (client?.username) {
      broadcast({ type: 'system', text: `${client.username} left the chat`, online: onlineCount() });
      // Only notify offline if no other connections remain for this user
      if (!isOnline(client.username)) notifyFriendsPresence(client.username, false, null);
    }
  });
});

server.listen(PORT, () => console.log(`InfinitiGames server on port ${PORT}`));
