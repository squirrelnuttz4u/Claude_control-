const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const SessionManager = require('./SessionManager');

const PORT = parseInt(process.env.PORT, 10) || 3200;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const manager = new SessionManager();

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// REST API for session management
app.use(express.json());

app.get('/api/sessions', (req, res) => {
  res.json(manager.listSessions());
});

app.post('/api/sessions', (req, res) => {
  const { id, cols, rows, cwd, command } = req.body || {};
  const sessionId = id || `session-${Date.now()}`;
  try {
    const info = manager.createSession(sessionId, { cols, rows, cwd, command });
    res.status(201).json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  manager.destroySession(req.params.id);
  res.json({ ok: true });
});

app.get('/api/sessions/:id', (req, res) => {
  const info = manager.getSessionInfo(req.params.id);
  if (!info) return res.status(404).json({ error: 'Not found' });
  res.json(info);
});

// WebSocket handling
wss.on('connection', (ws) => {
  // Send the current session list on connect
  ws.send(JSON.stringify({
    type: 'session_list',
    sessions: manager.listSessions(),
  }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'subscribe': {
        try {
          manager.subscribe(msg.sessionId, ws);
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', error: e.message }));
        }
        break;
      }

      case 'unsubscribe': {
        manager.unsubscribe(msg.sessionId, ws);
        break;
      }

      case 'input': {
        try {
          manager.writeToSession(msg.sessionId, msg.data);
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', error: e.message, sessionId: msg.sessionId }));
        }
        break;
      }

      case 'resize': {
        try {
          manager.resizeSession(msg.sessionId, msg.cols, msg.rows);
        } catch (e) {
          // ignore resize errors
        }
        break;
      }

      case 'create_session': {
        try {
          const info = manager.createSession(
            msg.id || `session-${Date.now()}`,
            { cols: msg.cols, rows: msg.rows, cwd: msg.cwd, command: msg.command }
          );
          // Broadcast updated session list to all clients
          broadcastSessionList();
          ws.send(JSON.stringify({ type: 'session_created', session: info }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', error: e.message }));
        }
        break;
      }

      case 'destroy_session': {
        manager.destroySession(msg.sessionId);
        broadcastSessionList();
        break;
      }

      case 'list_sessions': {
        ws.send(JSON.stringify({
          type: 'session_list',
          sessions: manager.listSessions(),
        }));
        break;
      }
    }
  });

  ws.on('close', () => {
    manager.unsubscribeAll(ws);
  });
});

function broadcastSessionList() {
  const msg = JSON.stringify({
    type: 'session_list',
    sessions: manager.listSessions(),
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let lanIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIP = iface.address;
        break;
      }
    }
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       Claude Control - Remote CLI Dashboard      ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}                 ║`);
  console.log(`║  Network: http://${lanIP}:${PORT}`.padEnd(53) + '║');
  console.log('║                                                  ║');
  console.log('║  Open the Network URL on your phone to connect   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
