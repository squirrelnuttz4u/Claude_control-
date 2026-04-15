const os = require('os');
const path = require('path');
const fs = require('fs');
const { findClaudeBinary, getUserShellEnv } = require('./utils/findClaude');
const { detectRunningClaudeSessions } = require('./utils/detectExternal');
const { FallbackPty } = require('./utils/fallbackPty');
const { TmuxPty, TmuxAttach, listCCTmuxSessions, hasTmux, TMUX_PREFIX } = require('./utils/tmuxPty');

// Try to load node-pty; if native addon is broken, we'll use the fallback
let pty = null;
let useFallbackPty = false;
const isWin = os.platform() === 'win32';
try {
  pty = require('node-pty');
  const testShell = isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
  const testArgs = isWin ? ['/c', 'exit 0'] : ['-c', 'exit 0'];
  const testProc = pty.spawn(testShell, testArgs, {
    name: 'xterm-256color', cols: 10, rows: 10,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  testProc.kill();
} catch (e) {
  console.log('  node-pty unavailable:', e.message);
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
    this._hasTmux = hasTmux();

    if (this._hasTmux) {
      console.log('  tmux: available (sessions persist across restarts)');
    } else {
      console.log('  tmux: not found (install for persistent sessions)');
    }
    console.log(`  Claude binary: ${this._claudeBinary}`);
    console.log(`  PTY backend: ${this._hasTmux ? 'tmux' : this._useFallback ? 'fallback (python/script)' : 'node-pty'}`);

    // Reconnect to any tmux sessions from a previous run
    this._reconnectTmuxSessions();

    this.refreshExternal();
    this._externalTimer = setInterval(() => this.refreshExternal(), 10000);
  }

  /**
   * On startup, find any tmux sessions we created previously and
   * re-attach to them so they appear in the dashboard immediately.
   */
  _reconnectTmuxSessions() {
    if (!this._hasTmux) return;
    const existing = listCCTmuxSessions();
    for (const tmuxName of existing) {
      const id = tmuxName.replace(new RegExp(`^${TMUX_PREFIX}`), '');
      if (this.sessions.has(id)) continue;

      console.log(`  Reconnecting to tmux session: ${tmuxName}`);
      try {
        const ptyProcess = new TmuxAttach(tmuxName);
        const session = {
          id,
          pty: ptyProcess,
          subscribers: new Set(),
          buffer: [],
          state: 'running',
          exitCode: null,
          cols: ptyProcess.cols,
          rows: ptyProcess.rows,
          cwd: 'reconnected',
          command: 'claude (reconnected)',
          createdAt: Date.now(),
          persistent: true,
        };

        ptyProcess.onData((data) => {
          session.buffer.push(data);
          if (session.buffer.length > this.bufferMaxLines) {
            session.buffer = session.buffer.slice(-Math.floor(this.bufferMaxLines * 0.8));
          }
          for (const ws of session.subscribers) {
            this._send(ws, { type: 'output', sessionId: id, data });
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          session.state = 'exited';
          session.exitCode = exitCode;
          for (const ws of session.subscribers) {
            this._send(ws, { type: 'session_exited', sessionId: id, exitCode });
          }
        });

        this.sessions.set(id, session);
      } catch (e) {
        console.log(`  Failed to reconnect ${tmuxName}: ${e.message}`);
      }
    }
    if (existing.length > 0) {
      console.log(`  Reconnected ${this.sessions.size} persistent session(s)`);
    }
  }

  createSession(id, { cols = 120, rows = 30, cwd, command } = {}) {
    id = id.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 64);
    if (!id) id = `session-${Date.now()}`;
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum ${this.maxSessions} sessions reached`);
    }

    // Find a verified shell (platform-specific)
    let loginShell, shellArgs;
    const isWin = os.platform() === 'win32';

    if (isWin) {
      // On Windows, use cmd.exe or powershell
      const winShells = [
        process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ];
      loginShell = winShells[0];
      for (const s of winShells) {
        try { if (fs.existsSync(s)) { loginShell = s; break; } } catch {}
      }
      const effectiveCmd = command || this._claudeBinary;
      // cmd /C runs a command then exits
      shellArgs = ['/C', effectiveCmd];
    } else {
      // Unix: use login shell
      const shellCandidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
      loginShell = '/bin/sh';
      for (const s of shellCandidates) {
        try { if (fs.statSync(s).isFile()) { loginShell = s; break; } } catch {}
      }
      const effectiveCmd = command || this._claudeBinary;
      shellArgs = ['-l', '-c', effectiveCmd];
    }

    const shell = loginShell;
    const args = shellArgs;

    const fallbackHome = process.env.HOME || os.homedir();
    let defaultCwd = cwd || fallbackHome;
    try {
      if (!fs.statSync(defaultCwd).isDirectory()) defaultCwd = fallbackHome;
    } catch { defaultCwd = fallbackHome; }

    const spawnOpts = {
      name: 'xterm-256color',
      cols, rows,
      cwd: defaultCwd,
      env: {
        ...this._shellEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    };

    let ptyProcess;

    // Priority 1: tmux (persistent sessions)
    if (this._hasTmux) {
      try {
        ptyProcess = new TmuxPty(id, shell, args, spawnOpts);
      } catch (e) {
        console.log(`  tmux spawn failed: ${e.message}, falling back`);
      }
    }

    // Priority 2: node-pty
    if (!ptyProcess && !this._useFallback) {
      try {
        ptyProcess = pty.spawn(shell, args, spawnOpts);
      } catch (e) {
        console.log(`  node-pty spawn failed: ${e.message}, switching to fallback`);
        this._useFallback = true;
      }
    }

    // Priority 3: Python/script fallback
    if (!ptyProcess) {
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
      state: 'running',
      exitCode: null,
      cols, rows,
      cwd: defaultCwd,
      command: command || this._claudeBinary,
      createdAt: Date.now(),
      persistent: this._hasTmux,
    };

    ptyProcess.onData((data) => {
      session.buffer.push(data);
      if (session.buffer.length > this.bufferMaxLines) {
        session.buffer = session.buffer.slice(-Math.floor(this.bufferMaxLines * 0.8));
      }
      for (const ws of session.subscribers) {
        this._send(ws, { type: 'output', sessionId: id, data });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.state = 'exited';
      session.exitCode = exitCode;
      for (const ws of session.subscribers) {
        this._send(ws, { type: 'session_exited', sessionId: id, exitCode, signal });
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

    if (session.buffer.length > 0) {
      let replay = session.buffer.join('');
      const maxReplayBytes = 512 * 1024;
      if (replay.length > maxReplayBytes) {
        replay = replay.slice(-maxReplayBytes);
      }
      this._send(ws, { type: 'buffer_replay', sessionId: id, data: replay });
    }

    if (session.state === 'exited') {
      this._send(ws, { type: 'session_exited', sessionId: id, exitCode: session.exitCode });
    }
  }

  unsubscribe(id, ws) {
    const session = this.sessions.get(id);
    if (session) session.subscribers.delete(ws);
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
      persistent: session.persistent || false,
    };
  }

  refreshExternal() {
    const ownPids = [];
    for (const session of this.sessions.values()) {
      if (session.pty && session.pty.pid) ownPids.push(session.pty.pid);
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
    for (const ext of this.externalSessions) {
      list.push(ext);
    }
    return list;
  }

  _send(ws, msg) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    } catch {}
  }
}

module.exports = SessionManager;
