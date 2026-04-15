const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const isWin = os.platform() === 'win32';
const PATH_SEP = isWin ? ';' : ':';

/**
 * Resolve the full path to the `claude` binary.
 * Searches common install locations for macOS, Linux, and Windows.
 */
function findClaudeBinary() {
  const home = os.homedir();
  const candidates = [];

  if (isWin) {
    // Windows install locations
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(appData, 'npm', 'claude'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(home, '.claude', 'bin', 'claude.exe'),
      path.join(home, '.claude', 'bin', 'claude.cmd'),
    );
    // npm global prefix on Windows
    try {
      const prefix = execSync('npm config get prefix', {
        encoding: 'utf-8', timeout: 3000, shell: true,
      }).trim();
      if (prefix) {
        candidates.push(path.join(prefix, 'claude.cmd'));
        candidates.push(path.join(prefix, 'claude'));
      }
    } catch {}
    // Search PATH
    const pathDirs = (process.env.PATH || '').split(';');
    for (const dir of pathDirs) {
      if (dir) {
        candidates.push(path.join(dir, 'claude.cmd'));
        candidates.push(path.join(dir, 'claude.exe'));
      }
    }
  } else {
    // macOS / Linux install locations
    candidates.push(
      path.join(home, '.claude', 'bin', 'claude'),
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/opt/local/bin/claude',
    );
    // nvm path
    const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
    try {
      const nodeVer = process.version.replace(/^v/, '');
      candidates.push(path.join(nvmDir, 'versions', 'node', `v${nodeVer}`, 'bin', 'claude'));
    } catch {}
    // npm global prefix
    try {
      const prefix = execSync('npm config get prefix 2>/dev/null', {
        encoding: 'utf-8', timeout: 3000, shell: true,
      }).trim();
      if (prefix) candidates.push(path.join(prefix, 'bin', 'claude'));
    } catch {}
    // Search PATH
    const pathDirs = (process.env.PATH || '').split(':');
    for (const dir of pathDirs) {
      if (dir) candidates.push(path.join(dir, 'claude'));
    }
  }

  // Check each candidate
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  // Unix: try login shell `which claude`
  if (!isWin) {
    const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
    for (const sh of shells) {
      try {
        if (!fs.existsSync(sh)) continue;
        const result = execSync(`${sh} -l -c 'which claude' 2>/dev/null`, {
          encoding: 'utf-8', timeout: 5000,
        }).trim();
        if (result && fs.existsSync(result)) return result;
      } catch {}
    }
  }

  // Windows: try `where claude`
  if (isWin) {
    try {
      const result = execSync('where claude', {
        encoding: 'utf-8', timeout: 5000, shell: true,
      }).trim().split('\n')[0];
      if (result && fs.existsSync(result)) return result;
    } catch {}
  }

  return 'claude';
}

/**
 * Build env with the user's full PATH merged in.
 * On Windows, PATH is already inherited; on Unix, we source the login shell.
 */
function getUserShellEnv() {
  const env = { ...process.env };

  if (isWin) {
    // Windows inherits PATH from the user's environment already
    return env;
  }

  try {
    const userShell = process.env.SHELL || '/bin/sh';
    const shellPath = execSync(
      `${userShell} -l -c 'echo "__PATH__=$PATH"' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const match = shellPath.match(/__PATH__=(.+)/);
    if (match) {
      const userPath = match[1].trim();
      const currentPath = process.env.PATH || '';
      const merged = [...new Set([...userPath.split(':'), ...currentPath.split(':')])].join(':');
      env.PATH = merged;
    }
  } catch {}
  return env;
}

module.exports = { findClaudeBinary, getUserShellEnv };
