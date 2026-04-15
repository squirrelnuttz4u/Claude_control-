const { spawn, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const EventEmitter = require('events');

/**
 * Fallback PTY implementation that works without node-pty.
 *
 * Strategy (in order):
 * 1. Python pty.spawn() - creates a real PTY, cleanest approach
 * 2. macOS `script` command - with stderr suppressed
 */
class FallbackPty extends EventEmitter {
  constructor(shell, args, options) {
    super();
    this.cols = options.cols || 120;
    this.rows = options.rows || 30;
    this.pid = null;
    this._process = null;
    this._exited = false;

    const env = {
      ...options.env,
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
    };

    const cmd = [shell, ...args];
    const python = findPython();

    if (python) {
      this._spawnViaPython(python, cmd, options.cwd, env);
    } else {
      this._spawnViaScript(cmd, options.cwd, env);
    }

    this.pid = this._process.pid;
    this._wireEvents();
  }

  _wireEvents() {
    this._process.stdout.on('data', (data) => {
      this.emit('data', data.toString());
    });

    // Suppress stderr entirely - child stderr goes through the PTY
    // (appears in stdout). Only the wrapper's own warnings come here.
    this._process.stderr.on('data', () => {});

    this._process.on('exit', (code, signal) => {
      if (this._exited) return;
      this._exited = true;
      this.emit('exit', { exitCode: code, signal: signal ? 1 : 0 });
    });

    this._process.on('error', (err) => {
      if (this._exited) return;
      this._exited = true;
      this.emit('data', `\r\n[Process error: ${err.message}]\r\n`);
      this.emit('exit', { exitCode: 1, signal: 0 });
    });
  }

  /**
   * Python pty.spawn() creates a proper pseudo-terminal and bridges
   * stdin/stdout. It gracefully handles piped stdin (no warnings).
   */
  _spawnViaPython(python, cmd, cwd, env) {
    // pty.spawn() handles everything: PTY creation, fork, I/O bridging.
    // When stdin is a pipe it skips raw mode silently.
    this._process = spawn(python, [
      '-u', '-c',
      'import pty,sys;pty.spawn(sys.argv[1:])',
      ...cmd,
    ], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /**
   * Fallback: macOS/Linux `script` command with stderr suppressed.
   */
  _spawnViaScript(cmd, cwd, env) {
    if (os.platform() === 'darwin') {
      this._process = spawn('script', ['-q', '/dev/null', ...cmd], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      const fullCmd = cmd.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      this._process = spawn('script', ['-qc', fullCmd, '/dev/null'], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  }

  write(data) {
    if (this._process && this._process.stdin && !this._process.stdin.destroyed) {
      this._process.stdin.write(data);
    }
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this._process && this._process.pid && !this._exited) {
      try { process.kill(this._process.pid, 'SIGWINCH'); } catch {}
    }
  }

  kill(signal) {
    if (this._process && !this._exited) {
      try { this._process.kill(signal || 'SIGHUP'); } catch {}
    }
  }

  onData(callback) { this.on('data', callback); }
  onExit(callback) { this.on('exit', callback); }
}

/** Find a working Python 3 binary. */
function findPython() {
  for (const py of ['python3', 'python']) {
    try {
      const v = execSync(`${py} -c "import pty,sys;print(sys.version_info.major)"`, {
        encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (v === '3') return py;
    } catch {}
  }
  for (const p of ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3']) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

module.exports = { FallbackPty };
