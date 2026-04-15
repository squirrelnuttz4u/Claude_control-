const { spawn } = require('child_process');
const os = require('os');
const EventEmitter = require('events');

/**
 * Fallback PTY implementation using child_process + macOS `script` command.
 * Used when node-pty's native addon fails (posix_spawnp errors on macOS).
 * Creates a real pseudo-terminal via the system `script` utility.
 */
class FallbackPty extends EventEmitter {
  constructor(shell, args, options) {
    super();
    this.shell = shell;
    this.args = args;
    this.cols = options.cols || 120;
    this.rows = options.rows || 30;
    this.pid = null;
    this._process = null;

    const env = {
      ...options.env,
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
    };

    if (os.platform() === 'darwin') {
      // macOS: script -q /dev/null <shell> <args...>
      // This creates a real PTY around the command
      this._process = spawn('script', ['-q', '/dev/null', shell, ...args], {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      // Linux: script -qc "<shell> <args>" /dev/null
      const fullCmd = [shell, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      this._process = spawn('script', ['-qc', fullCmd, '/dev/null'], {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    this.pid = this._process.pid;

    this._process.stdout.on('data', (data) => {
      this.emit('data', data.toString());
    });

    this._process.stderr.on('data', (data) => {
      this.emit('data', data.toString());
    });

    this._process.on('exit', (code, signal) => {
      this.emit('exit', { exitCode: code, signal: signal ? 1 : 0 });
    });

    this._process.on('error', (err) => {
      this.emit('data', `\r\n[Process error: ${err.message}]\r\n`);
      this.emit('exit', { exitCode: 1, signal: 0 });
    });
  }

  write(data) {
    if (this._process && this._process.stdin && !this._process.stdin.destroyed) {
      this._process.stdin.write(data);
    }
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    // Send SIGWINCH to notify the child about the terminal size change
    if (this._process && this._process.pid) {
      try {
        // Set new size via stty if possible, then signal
        process.kill(this._process.pid, 'SIGWINCH');
      } catch {}
    }
  }

  kill(signal) {
    if (this._process) {
      try {
        this._process.kill(signal || 'SIGHUP');
      } catch {}
    }
  }

  // Compatibility shims for node-pty API
  onData(callback) { this.on('data', callback); }
  onExit(callback) { this.on('exit', callback); }
}

module.exports = { FallbackPty };
