const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { WebSocketServer } = require('ws');

const PORT       = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');

// ── User store ────────────────────────────────────────────────
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}

let savePending = false;
function saveUsers() {
  if (savePending) return;
  savePending = true;
  setImmediate(() => {
    fs.writeFile(USERS_FILE, JSON.stringify(users), () => { savePending = false; });
  });
}

// ── Sessions (token → username) ───────────────────────────────
const sessions = new Map();

function genToken()                   { return crypto.randomBytes(32).toString('hex'); }
function hashPw(password, salt)       { return crypto.createHash('sha256').update(salt + password).digest('hex'); }

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

// ── Helpers ───────────────────────────────────────────────────
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
  res.setHeader('Set-Cookie',
    `igSession=${token}; Path=/; Max-Age=${60*60*24*30}; HttpOnly; SameSite=Strict`);
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
    if (err) { res.writeHead(404, {'Content-Type':'text/html'}); return res.end('<h1>404 – Not Found</h1>'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── HTTP server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // ── API routes ──
  if (url.startsWith('/api/')) {

    // GET /api/me
    if (url === '/api/me' && req.method === 'GET') {
      const username = sessionUser(req);
      if (!username) return json(res, 401, { error: 'Not logged in' });
      return json(res, 200, { username });
    }

    // POST /api/register
    if (url === '/api/register' && req.method === 'POST') {
      const { username = '', password = '' } = await readBody(req);
      const u = username.trim(), p = password;
      if (!u || !p)          return json(res, 400, { error: 'Username and password are required.' });
      if (u.length < 3)      return json(res, 400, { error: 'Username must be at least 3 characters.' });
      if (p.length < 4)      return json(res, 400, { error: 'Password must be at least 4 characters.' });
      if (!/^[a-zA-Z0-9_]+$/.test(u)) return json(res, 400, { error: 'Username can only contain letters, numbers and underscores.' });
      if (users[u.toLowerCase()]) return json(res, 409, { error: 'Username already taken.' });
      const salt = crypto.randomBytes(16).toString('hex');
      users[u.toLowerCase()] = { username: u, hash: hashPw(p, salt), salt };
      saveUsers();
      const token = genToken();
      sessions.set(token, u);
      setCookie(res, token);
      return json(res, 200, { username: u });
    }

    // POST /api/login
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

    // POST /api/logout
    if (url === '/api/logout' && req.method === 'POST') {
      const { igSession } = parseCookies(req.headers.cookie);
      if (igSession) sessions.delete(igSession);
      clearCookie(res);
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
const clients = new Map();

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  for (const [ws] of clients)
    if (ws !== excludeWs && ws.readyState === ws.OPEN) ws.send(msg);
}
function broadcastAll(data) { broadcast(data, null); }
function onlineCount()      { return clients.size; }

wss.on('connection', (ws, req) => {
  const username = sessionUser(req);
  clients.set(ws, { username });

  if (username) {
    ws.send(JSON.stringify({ type: 'joined', username, online: onlineCount() }));
    broadcast({ type: 'system', text: `${username} joined the chat`, online: onlineCount() }, ws);
  } else {
    ws.send(JSON.stringify({ type: 'auth_required' }));
  }

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);

    // join: client sends username after logging in (WS may have opened before cookie was set)
    if (msg.type === 'join') {
      if (!client.username && msg.username) {
        client.username = String(msg.username).trim().slice(0, 24);
        ws.send(JSON.stringify({ type: 'joined', username: client.username, online: onlineCount() }));
        broadcast({ type: 'system', text: `${client.username} joined the chat`, online: onlineCount() }, ws);
      }
      return;
    }

    if (msg.type === 'message') {
      if (!client?.username) return;
      const text = String(msg.text || '').trim().slice(0, 500);
      if (!text) return;
      broadcastAll({
        type:     'message',
        username: client.username,
        text,
        time:     new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
        online:   onlineCount(),
      });
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    clients.delete(ws);
    if (client?.username)
      broadcast({ type: 'system', text: `${client.username} left the chat`, online: onlineCount() });
  });
});

server.listen(PORT, () => console.log(`InfinitiGames server on port ${PORT}`));
