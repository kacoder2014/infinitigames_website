const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.htm':  'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp3':  'audio/mpeg',
  '.mp4':  'video/mp4',
};

// ── HTTP server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, urlPath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      return serveFile(path.join(filePath, 'index.html'), res);
    }
    serveFile(filePath, res);
  });
});

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<h1>404 – Page Not Found</h1>');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── WebSocket server ─────────────────────────────────────────
const wss = new WebSocketServer({ server });

// Track connected clients: ws -> { username }
const clients = new Map();

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws !== excludeWs && ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

function broadcastAll(data) {
  broadcast(data, null);
}

function onlineCount() {
  return clients.size;
}

wss.on('connection', (ws) => {
  // Assign temporary id until username is set
  clients.set(ws, { username: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients.get(ws);

    if (msg.type === 'join') {
      // Sanitise username
      const username = String(msg.username || '').trim().slice(0, 24) || 'Anonymous';
      client.username = username;

      // Send history / welcome back to this client only
      ws.send(JSON.stringify({ type: 'system', text: `Welcome, ${username}! 👋`, online: onlineCount() }));

      // Announce to everyone else
      broadcast({ type: 'system', text: `${username} joined the chat`, online: onlineCount() }, ws);
      return;
    }

    if (msg.type === 'message') {
      if (!client.username) return; // must join first
      const text = String(msg.text || '').trim().slice(0, 500);
      if (!text) return;

      const payload = {
        type:     'message',
        username: client.username,
        text,
        time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        online:   onlineCount(),
      };
      broadcastAll(payload);
      return;
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    clients.delete(ws);
    if (client && client.username) {
      broadcast({ type: 'system', text: `${client.username} left the chat`, online: onlineCount() });
    }
  });
});

// ── Start ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`InfinitiGames server running on port ${PORT}`);
});
