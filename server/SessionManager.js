const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { findClaudeBinary, getUserShellEnv } = require('./utils/findClaude');
const { detectRunningClaudeSessions } = require('./utils/detectExternal');

class SessionManager {
  constructor() {
    this.sessions = new Map(); // id -> { pty, subscribers: Set<ws>, buffer: string[], state }
    this.externalSessions = []; // detected external claude processes
    this.maxSessions = 8;
    this.bufferMaxLines = 5000;
    this._shellEnv = getUserShellEnv();
    this._claudeBinary = findClaudeBinary();
    console.log(`  Claude binary: ${this._claudeBinary}`);
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

    // Parse command: if it contains spaces/args, run via shell
    let shell, args;
    if (command && command.includes(' ')) {
      shell = process.env.SHELL || '/bin/sh';
      args = ['-c', command];
    } else {
      shell = command || this._claudeBinary;
      args = [];
    }
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

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: defaultCwd,
      env: {
        ...this._shellEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

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
