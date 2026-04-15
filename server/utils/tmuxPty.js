const { spawn, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const EventEmitter = require('events');

const TMUX_PREFIX = 'cc-'; // prefix for Claude Control tmux sessions

/**
 * tmux-backed PTY. Each session runs inside a tmux session so that:
 * 1. Sessions persist when the dashboard server restarts
 * 2. Multiple clients can attach/detach at will
 * 3. We get real PTY with full terminal emulation
 *
 * Uses `tmux pipe-pane` to stream output and `tmux send-keys` for input.
 */
class TmuxPty extends EventEmitter {
  constructor(sessionName, shell, args, options) {
    super();
    this.sessionName = TMUX_PREFIX + sessionName;
    this.cols = options.cols || 120;
    this.rows = options.rows || 30;
    this.pid = null;
    this._exited = false;
    this._outputReader = null;
    this._pollTimer = null;

    const cwd = options.cwd || os.homedir();
    const env = options.env || {};

    // Build environment exports for the tmux session
    const envExports = Object.entries({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
      ...env,
    }).filter(([k]) => ['TERM', 'COLORTERM', 'PATH', 'HOME', 'SHELL', 'LANG', 'COLUMNS', 'LINES'].includes(k))
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
      .join('; ');

    const fullCmd = [shell, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

    // Create a new tmux session running the command
    try {
      execSync(
        `tmux new-session -d -s "${this.sessionName}" -x ${this.cols} -y ${this.rows} "${envExports}; cd '${cwd.replace(/'/g, "'\\''")}'; exec ${fullCmd}"`,
        { encoding: 'utf-8', timeout: 5000, env: { ...process.env, ...env } }
      );
    } catch (e) {
      throw new Error(`Failed to create tmux session: ${e.message}`);
    }

    // Get the tmux server pid for the session
    try {
      const pidStr = execSync(
        `tmux list-panes -t "${this.sessionName}" -F "#{pane_pid}"`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim();
      this.pid = parseInt(pidStr, 10) || process.pid;
    } catch {
      this.pid = process.pid;
    }

    this._startOutputStreaming();
    this._startExitPolling();
  }

  /**
   * Stream output from the tmux pane using `tmux capture-pane` polling.
   * Tracks content by length and sends only new data.
   */
  _startOutputStreaming() {
    let lastContent = '';

    this._pollTimer = setInterval(() => {
      if (this._exited) return;
      try {
        const content = execSync(
          `tmux capture-pane -t "${this.sessionName}" -p -S -500 2>/dev/null`,
          { encoding: 'utf-8', timeout: 2000, maxBuffer: 1024 * 1024 }
        ).replace(/\n+$/, '\n'); // normalize trailing newlines

        if (content !== lastContent) {
          if (lastContent === '') {
            // First capture - send everything
            this.emit('data', content);
          } else if (content.startsWith(lastContent)) {
            // New content appended - send only the new part
            this.emit('data', content.substring(lastContent.length));
          } else {
            // Content changed completely (e.g. screen clear) - resend all
            this.emit('data', '\x1b[2J\x1b[H' + content);
          }
          lastContent = content;
        }
      } catch {
        this._checkExit();
      }
    }, 150);
  }

  _startExitPolling() {
    // Check every second if the tmux session still exists
    this._exitPollTimer = setInterval(() => {
      this._checkExit();
    }, 1000);
  }

  _checkExit() {
    if (this._exited) return;
    try {
      execSync(`tmux has-session -t "${this.sessionName}" 2>/dev/null`, { timeout: 2000 });
    } catch {
      // Session no longer exists
      this._exited = true;
      if (this._pollTimer) clearInterval(this._pollTimer);
      if (this._exitPollTimer) clearInterval(this._exitPollTimer);
      this.emit('exit', { exitCode: 0, signal: 0 });
    }
  }

  write(data) {
    if (this._exited) return;
    try {
      // Handle control characters explicitly
      if (data === '\x03') {
        execSync(`tmux send-keys -t "${this.sessionName}" C-c`, { timeout: 2000 });
        return;
      }
      if (data === '\x04') {
        execSync(`tmux send-keys -t "${this.sessionName}" C-d`, { timeout: 2000 });
        return;
      }

      // Split on newlines: send text literally, then Enter for each \n
      const parts = data.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].length > 0) {
          execSync(`tmux send-keys -t "${this.sessionName}" -l ${shellEscape(parts[i])}`, { timeout: 2000 });
        }
        // Send Enter for each \n (but not after the last chunk if there's no trailing newline)
        if (i < parts.length - 1) {
          execSync(`tmux send-keys -t "${this.sessionName}" Enter`, { timeout: 2000 });
        }
      }

      // Handle trailing \r as Enter too
      if (data.endsWith('\r')) {
        execSync(`tmux send-keys -t "${this.sessionName}" Enter`, { timeout: 2000 });
      }
    } catch {}
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this._exited) return;
    try {
      execSync(`tmux resize-window -t "${this.sessionName}" -x ${cols} -y ${rows} 2>/dev/null`, { timeout: 2000 });
    } catch {}
  }

  kill(signal) {
    if (this._exited) return;
    try {
      execSync(`tmux kill-session -t "${this.sessionName}" 2>/dev/null`, { timeout: 2000 });
    } catch {}
    this._exited = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._exitPollTimer) clearInterval(this._exitPollTimer);
  }

  onData(callback) { this.on('data', callback); }
  onExit(callback) { this.on('exit', callback); }
}

/**
 * Attach to an existing tmux session (e.g., from a previous server run).
 * Returns a TmuxPty-compatible object that streams output and accepts input.
 */
class TmuxAttach extends EventEmitter {
  constructor(tmuxSessionName) {
    super();
    this.sessionName = tmuxSessionName;
    this._exited = false;
    this._pollTimer = null;
    this._exitPollTimer = null;

    // Get pane dimensions
    try {
      const info = execSync(
        `tmux list-panes -t "${this.sessionName}" -F "#{pane_width} #{pane_height} #{pane_pid}"`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim().split(' ');
      this.cols = parseInt(info[0], 10) || 120;
      this.rows = parseInt(info[1], 10) || 30;
      this.pid = parseInt(info[2], 10) || 0;
    } catch {
      this.cols = 120;
      this.rows = 30;
      this.pid = 0;
    }

    this._startOutputStreaming();
    this._startExitPolling();
  }

  // Reuse TmuxPty's methods
  _startOutputStreaming() { TmuxPty.prototype._startOutputStreaming.call(this); }
  _startExitPolling() { TmuxPty.prototype._startExitPolling.call(this); }
  _checkExit() { TmuxPty.prototype._checkExit.call(this); }
  write(data) { TmuxPty.prototype.write.call(this, data); }
  resize(cols, rows) { TmuxPty.prototype.resize.call(this, cols, rows); }
  kill(signal) { TmuxPty.prototype.kill.call(this, signal); }
  onData(callback) { this.on('data', callback); }
  onExit(callback) { this.on('exit', callback); }
}

/**
 * List existing Claude Control tmux sessions.
 */
function listCCTmuxSessions() {
  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^${TMUX_PREFIX}"`,
      { encoding: 'utf-8', timeout: 3000, shell: true }
    ).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if tmux is available on the system.
 */
function hasTmux() {
  try {
    execSync('tmux -V', { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function shellEscape(str) {
  // Escape for shell single-quote context
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

module.exports = { TmuxPty, TmuxAttach, listCCTmuxSessions, hasTmux, TMUX_PREFIX };
