/** SIGTERM only the session's omp pid. Never parent, group, or IDE. */

const BLOCKED =
  /superconductor|cursor|visual studio code|code helper|electron|iterm2?|terminal\.app|windowserver|launchd/i;
const ALLOWED = /(^|[\s/])(bun|omp|node)([\s/]|$)|pi-coding-agent/i;

export function isKillableSessionCommand(command: string | null): boolean {
  if (!command) return false;
  if (BLOCKED.test(command)) return false;
  return ALLOWED.test(command);
}

export function readProcessCommand(pid: number): string | null {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim() || null;
}

/** SIGTERM `pid` only. Returns false when skipped or already gone. */
export function killSessionProcess(pid: number, daemonPid = process.pid): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === daemonPid) return false;
  if (!isKillableSessionCommand(readProcessCommand(pid))) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
