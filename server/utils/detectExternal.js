const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');

const isWin = os.platform() === 'win32';

/**
 * Detect Claude Code CLI processes already running on the system.
 * Uses `ps` on Unix, `tasklist`/PowerShell on Windows.
 */
function detectRunningClaudeSessions(ownPids) {
  const ownPidSet = new Set(ownPids || []);
  try {
    if (isWin) {
      return detectWindows(ownPidSet);
    } else {
      return detectUnix(ownPidSet);
    }
  } catch {
    return [];
  }
}

function detectUnix(ownPidSet) {
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
    if (ownPidSet.has(pid)) continue;
    if (/^(grep|sh -c|\/bin\/sh)/.test(cmd)) continue;
    if (!/(^|\/)claude(\s|$)/i.test(cmd)) continue;

    let cwd = null;
    try {
      if (os.platform() === 'darwin') {
        const lsof = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, {
          encoding: 'utf-8', timeout: 2000, shell: true,
        }).trim();
        if (lsof) cwd = lsof.replace(/^n/, '');
      } else {
        const link = `/proc/${pid}/cwd`;
        if (fs.existsSync(link)) cwd = fs.readlinkSync(link);
      }
    } catch {}

    const displayCmd = cmd.length > 80 ? cmd.substring(0, 77) + '...' : cmd;
    sessions.push({ pid, command: displayCmd, cwd: cwd || 'unknown' });
  }
  return sessions;
}

function detectWindows(ownPidSet) {
  // Use PowerShell to get process details (more reliable than tasklist)
  const psCmd = `powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -like '*claude*' } | Select-Object Id, ProcessName, Path | ConvertTo-Json"`;
  const output = execSync(psCmd, {
    encoding: 'utf-8', timeout: 5000, shell: true,
  }).trim();

  if (!output) return [];

  let processes = JSON.parse(output);
  if (!Array.isArray(processes)) processes = [processes];

  const sessions = [];
  for (const proc of processes) {
    if (!proc || !proc.Id) continue;
    const pid = proc.Id;
    if (ownPidSet.has(pid)) continue;

    const cmd = proc.Path || proc.ProcessName || 'claude';
    const displayCmd = cmd.length > 80 ? cmd.substring(0, 77) + '...' : cmd;
    sessions.push({ pid, command: displayCmd, cwd: 'unknown' });
  }
  return sessions;
}

module.exports = { detectRunningClaudeSessions };
