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
    broadcastSessionList();
    res.status(201).json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  manager.destroySession(req.params.id);
  broadcastSessionList();
  res.json({ ok: true });
});

// Directory browser API for the "New Session" modal
app.get('/api/browse', (req, res) => {
  const fs = require('fs');
  const dirPath = req.query.path || os.homedir();
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return res.json({ path: path.dirname(dirPath), entries: [] });
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    res.json({ path: dirPath, parent: path.dirname(dirPath), entries });
  } catch {
    // Fall back to home dir if path is inaccessible
    const home = os.homedir();
    try {
      const entries = fs.readdirSync(home, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      res.json({ path: home, parent: path.dirname(home), entries });
    } catch {
      res.json({ path: home, parent: home, entries: [] });
    }
  }
});

// Create a new folder inside the browsed directory
app.post('/api/browse/mkdir', (req, res) => {
  const fs = require('fs');
  const { parent, name } = req.body || {};
  if (!parent || !name) {
    return res.status(400).json({ error: 'parent and name are required' });
  }
  // Sanitize folder name: no path separators or special chars
  const safeName = name.replace(/[/\\:*?"<>|]/g, '').trim();
  if (!safeName) {
    return res.status(400).json({ error: 'Invalid folder name' });
  }
  const fullPath = path.join(parent, safeName);
  try {
    fs.mkdirSync(fullPath, { recursive: true });
    res.json({ ok: true, path: fullPath });
  } catch (e) {
    res.status(400).json({ error: `Could not create folder: ${e.message}` });
  }
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
        if (typeof msg.data !== 'string') {
          ws.send(JSON.stringify({ type: 'error', error: 'Input must be a string', sessionId: msg.sessionId }));
          break;
        }
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

      case 'restart_session': {
        try {
          const oldInfo = manager.getSessionInfo(msg.sessionId);
          const opts = oldInfo ? { cols: oldInfo.cols, rows: oldInfo.rows, cwd: oldInfo.cwd, command: oldInfo.command } : {};
          manager.destroySession(msg.sessionId);
          const info = manager.createSession(msg.sessionId, opts);
          broadcastSessionList();
          ws.send(JSON.stringify({ type: 'session_restarted', session: info }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', error: e.message }));
        }
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

// Graceful shutdown: detach from sessions but keep tmux sessions alive
function shutdown() {
  console.log('\nShutting down dashboard server...');
  const sessions = manager.listSessions().filter(s => s.type !== 'external');
  const persistent = sessions.filter(s => s.persistent);
  const ephemeral = sessions.filter(s => !s.persistent);

  // Kill non-persistent sessions
  for (const session of ephemeral) {
    manager.destroySession(session.id);
  }

  if (persistent.length > 0) {
    console.log(`  ${persistent.length} tmux session(s) will keep running.`);
    console.log('  Restart the dashboard to reconnect to them.');
  }

  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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

  const W = 52; // inner width of banner box
  const pad = (str) => '║' + str.padEnd(W) + '║';
  const line = '═'.repeat(W);

  console.log('');
  console.log(`╔${line}╗`);
  console.log(pad('       Claude Control - Remote CLI Dashboard      '));
  console.log(`╠${line}╣`);
  console.log(pad(`  Local:   http://localhost:${PORT}`));
  console.log(pad(`  Network: http://${lanIP}:${PORT}`));
  console.log(pad(''));
  console.log(pad('  Open the Network URL on your phone to connect'));
  console.log(`╚${line}╝`);

  if (os.platform() === 'darwin') {
    // Check macOS firewall state
    let fwBlocking = false;
    try {
      const { execSync } = require('child_process');
      const fwState = execSync('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>&1', {
        encoding: 'utf-8', timeout: 3000,
      });
      if (fwState.includes('enabled')) {
        fwBlocking = true;
      }
    } catch {}

    if (fwBlocking) {
      console.log('');
      console.log('  \x1b[33m*** macOS Firewall is ON ***\x1b[0m');
      console.log('  Your phone may not be able to connect.');
      console.log('  Run this command to fix it:');
      console.log('');
      console.log('    \x1b[36msudo npm run setup-mac\x1b[0m');
      console.log('');
      console.log('  Or manually:');
      console.log('    \x1b[36msudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node)\x1b[0m');
      console.log('    \x1b[36msudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)\x1b[0m');
    } else {
      console.log('');
      console.log('  macOS firewall: OK (disabled or Node.js allowed)');
    }
    console.log('  Both devices must be on the same Wi-Fi network.');
  }
  console.log('');
});
