const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Resolve the full path to the `claude` binary by searching common
 * install locations, npm global paths, and the user's login shell PATH.
 */
function findClaudeBinary() {
  const home = os.homedir();

  const candidates = [
    path.join(home, '.claude', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',         // macOS Apple Silicon (Homebrew)
    '/usr/local/bin/claude',            // macOS Intel (Homebrew) / Linux
    '/opt/local/bin/claude',            // MacPorts
  ];

  // Add nvm-managed node bin path
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  try {
    const nodeVer = process.version.replace(/^v/, '');
    candidates.push(path.join(nvmDir, 'versions', 'node', `v${nodeVer}`, 'bin', 'claude'));
  } catch {}

  // Add npm global prefix
  try {
    const prefix = execSync('npm config get prefix 2>/dev/null', {
      encoding: 'utf-8', timeout: 3000, shell: true,
    }).trim();
    if (prefix) candidates.push(path.join(prefix, 'bin', 'claude'));
  } catch {}

  // Check each candidate
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  // Try the user's login shell `which claude`
  try {
    const userShell = process.env.SHELL || '/bin/sh';
    const result = execSync(`${userShell} -l -c 'which claude' 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {}

  // Last resort — return bare name and hope the PATH has it
  return 'claude';
}

/**
 * Build a PATH string that merges the current process PATH with the
 * user's login shell PATH so spawned PTYs can find binaries the user
 * has installed (e.g. via Homebrew, nvm, etc.).
 */
function getUserShellEnv() {
  const env = { ...process.env };
  try {
    const userShell = process.env.SHELL || '/bin/sh';
    const shellPath = execSync(
      `${userShell} -l -c 'echo "__PATH__=$PATH"' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const match = shellPath.match(/__PATH__=(.+)/);
    if (match) {
      // Merge: user shell PATH first, then current process PATH as fallback
      const userPath = match[1].trim();
      const currentPath = process.env.PATH || '';
      const merged = [...new Set([...userPath.split(':'), ...currentPath.split(':')])].join(':');
      env.PATH = merged;
    }
  } catch {}
  return env;
}

module.exports = { findClaudeBinary, getUserShellEnv };
