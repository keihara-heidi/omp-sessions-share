/** SIGTERM only the session's omp pid, then close its matching Terminal.app window. */

const BLOCKED =
  /cursor|visual studio code|code helper|electron|iterm2?|terminal\.app|windowserver|launchd/i;
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

function readProcessTty(pid: number): string | null {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "tty="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const tty = new TextDecoder().decode(result.stdout).trim();
  if (!tty || tty === "??" || tty === "-") return null;
  return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
}

export function buildCloseTerminalArgs(tty: string): string[] {
  return [
    "/usr/bin/osascript",
    "-e",
    `on run argv
tell application "Terminal"
repeat with w in windows
if (count of tabs of w) is 1 and tty of selected tab of w is item 1 of argv then
close w
return
end if
end repeat
end tell
end run`,
    tty,
  ];
}

function closeTerminalWindow(tty: string): void {
  Bun.spawnSync(buildCloseTerminalArgs(tty), {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** SIGTERM `pid`, then close its single-tab Terminal.app window for the same TTY. */
export function killSessionProcess(pid: number, daemonPid = process.pid): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === daemonPid) return false;
  if (!isKillableSessionCommand(readProcessCommand(pid))) return false;
  const tty = readProcessTty(pid);
  try {
    process.kill(pid, "SIGTERM");
    if (tty) closeTerminalWindow(tty);
    return true;
  } catch {
    return false;
  }
}
