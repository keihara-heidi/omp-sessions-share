import { spawn, type ChildProcess } from "node:child_process";

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { stdio: "ignore" },
) => ChildProcess;

/**
 * Holds a macOS idle-sleep assertion while the daemon has live shared sessions.
 * The `-w` guard releases it if the daemon exits before explicit cleanup runs.
 */
export class MacSleepInhibitor {
  private child: ChildProcess | null = null;

  constructor(
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly parentPid = process.pid,
    private readonly platform = process.platform,
  ) {}

  start(): boolean {
    if (this.child) return true;
    if (this.platform !== "darwin") return false;

    let child: ChildProcess;
    try {
      child = this.spawnProcess(
        "/usr/bin/caffeinate",
        ["-i", "-w", String(this.parentPid)],
        { stdio: "ignore" },
      );
    } catch {
      return false;
    }

    this.child = child;
    const clear = () => {
      if (this.child === child) this.child = null;
    };
    child.once("error", clear);
    child.once("exit", clear);
    return true;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }

  get active(): boolean {
    return this.child !== null;
  }
}
