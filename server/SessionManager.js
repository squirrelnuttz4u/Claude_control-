const os = require('os');
const path = require('path');
const fs = require('fs');
const { findClaudeBinary, getUserShellEnv } = require('./utils/findClaude');
const { detectRunningClaudeSessions } = require('./utils/detectExternal');
const { FallbackPty } = require('./utils/fallbackPty');

// Try to load node-pty; if native addon is broken, we'll use the fallback
let pty = null;
let useFallbackPty = false;
try {
  pty = require('node-pty');
  // Test spawn to confirm the native addon actually works
  const testProc = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
    name: 'xterm-256color', cols: 10, rows: 10,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  testProc.kill();
} catch (e) {
  console.log('  node-pty unavailable:', e.message);
  console.log('  Using fallback PTY (script-based). Terminal features may be limited.');
  useFallbackPty = true;
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.externalSessions = [];
    this.maxSessions = 8;
    this.bufferMaxLines = 5000;
    this._shellEnv = getUserShellEnv();
    this._claudeBinary = findClaudeBinary();
    this._useFallback = useFallbackPty;
    console.log(`  Claude binary: ${this._claudeBinary}`);
    console.log(`  PTY backend: ${this._useFallback ? 'fallback (script)' : 'node-pty'}`);
    this.refreshExternal();
    this._externalTimer = setInterval(() => this.refreshExternal(), 10000);
  }

  createSession(id, { cols = 120, rows = 30, cwd, command } = {}) {
    // Sanitize session ID to safe characters only
    id = id.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 64);
    if (!id) id = `session-${Date.now()}`;
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum ${this.maxSessions} sessions reached`);
    }

    // Find a shell binary that actually exists on this system
    const shellCandidates = [
      process.env.SHELL,
      '/bin/zsh',
      '/bin/bash',
      '/bin/sh',
    ].filter(Boolean);
    let loginShell = '/bin/sh'; // ultimate fallback
    for (const s of shellCandidates) {
      try { if (fs.statSync(s).isFile()) { loginShell = s; break; } } catch {}
    }

    // Build the command to run inside the shell
    const effectiveCmd = command || this._claudeBinary;

    // ALWAYS spawn through a verified login shell with -l -i -c
    // This ensures the user's PATH, aliases, etc. are loaded
    const shell = loginShell;
    const args = ['-l', '-c', effectiveCmd];

    const fallbackHome = process.env.HOME || os.homedir();
    let defaultCwd = cwd || fallbackHome;
    // Validate cwd exists and is a directory, fall back to HOME
    try {
      if (!fs.statSync(defaultCwd).isDirectory()) {
        defaultCwd = fallbackHome;
      }
    } catch {
      defaultCwd = fallbackHome;
    }

    const spawnOpts = {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: defaultCwd,
      env: {
        ...this._shellEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    };

    let ptyProcess;
    if (!this._useFallback) {
      // Try node-pty first
      try {
        ptyProcess = pty.spawn(shell, args, spawnOpts);
      } catch (e) {
        console.log(`  node-pty spawn failed: ${e.message}, switching to fallback`);
        this._useFallback = true;
      }
    }

    if (!ptyProcess) {
      // Fallback: use script-based PTY
      try {
        ptyProcess = new FallbackPty(shell, args, spawnOpts);
      } catch (spawnErr) {
        throw new Error(
          `Failed to start "${effectiveCmd}": ${spawnErr.message}. ` +
          `Verify the command is installed (run "which claude" in your terminal).`
        );
      }
    }

    const session = {
      id,
      pty: ptyProcess,
      subscribers: new Set(),
      buffer: [],
      state: 'running', // running | exited
      exitCode: null,
      cols,
      rows,
      cwd: defaultCwd,
      command: command || this._claudeBinary,
      createdAt: Date.now(),
    };

    ptyProcess.onData((data) => {
      // Append to scrollback buffer
      session.buffer.push(data);
      if (session.buffer.length > this.bufferMaxLines) {
        session.buffer = session.buffer.slice(-Math.floor(this.bufferMaxLines * 0.8));
      }

      // Broadcast to all subscribers
      for (const ws of session.subscribers) {
        this._send(ws, {
          type: 'output',
          sessionId: id,
          data,
        });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.state = 'exited';
      session.exitCode = exitCode;

      for (const ws of session.subscribers) {
        this._send(ws, {
          type: 'session_exited',
          sessionId: id,
          exitCode,
          signal,
        });
      }
    });

    this.sessions.set(id, session);
    return this.getSessionInfo(id);
  }

  writeToSession(id, data) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (session.state === 'exited') throw new Error(`Session ${id} has exited`);
    session.pty.write(data);
  }

  resizeSession(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    // Clamp to safe range
    cols = Math.max(1, Math.min(500, Math.floor(Number(cols) || 80)));
    rows = Math.max(1, Math.min(200, Math.floor(Number(rows) || 24)));
    if (session.state !== 'exited') {
      session.pty.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
    }
  }

  subscribe(id, ws) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    session.subscribers.add(ws);

    // Send buffered output so the client catches up, capped at 512KB
    if (session.buffer.length > 0) {
      let replay = session.buffer.join('');
      const maxReplayBytes = 512 * 1024;
      if (replay.length > maxReplayBytes) {
        replay = replay.slice(-maxReplayBytes);
      }
      this._send(ws, {
        type: 'buffer_replay',
        sessionId: id,
        data: replay,
      });
    }

    if (session.state === 'exited') {
      this._send(ws, {
        type: 'session_exited',
        sessionId: id,
        exitCode: session.exitCode,
      });
    }
  }

  unsubscribe(id, ws) {
    const session = this.sessions.get(id);
    if (session) {
      session.subscribers.delete(ws);
    }
  }

  unsubscribeAll(ws) {
    for (const session of this.sessions.values()) {
      session.subscribers.delete(ws);
    }
  }

  destroySession(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.state !== 'exited') {
      session.pty.kill();
    }
    session.subscribers.clear();
    this.sessions.delete(id);
  }

  getSessionInfo(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      id: session.id,
      state: session.state,
      exitCode: session.exitCode,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      command: session.command,
      createdAt: session.createdAt,
      bufferSize: session.buffer.length,
    };
  }

  refreshExternal() {
    // Collect PIDs of our own managed sessions to exclude them
    const ownPids = [];
    for (const session of this.sessions.values()) {
      if (session.pty && session.pty.pid) {
        ownPids.push(session.pty.pid);
      }
    }
    const detected = detectRunningClaudeSessions(ownPids);
    this.externalSessions = detected.map(proc => ({
      id: `external-${proc.pid}`,
      pid: proc.pid,
      state: 'external',
      type: 'external',
      command: proc.command,
      cwd: proc.cwd,
      createdAt: Date.now(),
    }));
  }

  listSessions() {
    const list = [];
    for (const id of this.sessions.keys()) {
      list.push(this.getSessionInfo(id));
    }
    // Append detected external sessions
    for (const ext of this.externalSessions) {
      list.push(ext);
    }
    return list;
  }

  _send(ws, msg) {
    try {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify(msg));
      }
    } catch (e) {
      // ignore send errors on closed sockets
    }
  }
}

module.exports = SessionManager;
