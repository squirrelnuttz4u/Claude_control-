const { execSync } = require('child_process');
const os = require('os');

/**
 * Detect Claude Code CLI processes already running on the system.
 * Returns an array of { pid, command, cwd } objects.
 */
function detectRunningClaudeSessions(ownPids) {
  const ownPidSet = new Set(ownPids || []);
  try {
    // grep for 'claude' processes, exclude grep itself with [c] trick
    // Use -ww to get full command even if wide
    const psOutput = execSync(
      "ps -eo pid,command | grep -i '[c]laude' || true",
      { encoding: 'utf-8', timeout: 5000, shell: true }
    ).trim();

    if (!psOutput) return [];

    const sessions = [];
    for (const line of psOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) continue;

      const pid = parseInt(trimmed.substring(0, spaceIdx), 10);
      const cmd = trimmed.substring(spaceIdx + 1).trim();

      if (isNaN(pid)) continue;
      // Skip our own managed PTY child processes
      if (ownPidSet.has(pid)) continue;
      // Skip helper processes (node, grep, sh -c wrappers)
      if (/^(grep|sh -c|\/bin\/sh)/.test(cmd)) continue;
      // Must look like a claude process
      if (!/(^|\/)claude(\s|$)/i.test(cmd)) continue;

      // Try to get working directory via lsof (macOS) or /proc (Linux)
      let cwd = null;
      try {
        if (os.platform() === 'darwin') {
          const lsof = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, {
            encoding: 'utf-8', timeout: 2000, shell: true,
          }).trim();
          if (lsof) cwd = lsof.replace(/^n/, '');
        } else {
          const link = `/proc/${pid}/cwd`;
          const fs = require('fs');
          if (fs.existsSync(link)) cwd = fs.readlinkSync(link);
        }
      } catch {}

      // Truncate command for display (can be very long with --append-system-prompt)
      const displayCmd = cmd.length > 80 ? cmd.substring(0, 77) + '...' : cmd;
      sessions.push({
        pid,
        command: displayCmd,
        cwd: cwd || 'unknown',
      });
    }

    return sessions;
  } catch {
    return [];
  }
}

module.exports = { detectRunningClaudeSessions };
