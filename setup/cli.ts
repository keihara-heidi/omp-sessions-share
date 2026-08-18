#!/usr/bin/env bun
/**
 * Terminal control plane for the local sessions-share dashboard.
 * Secrets are never accepted via argv. Only the dashboard password is printed
 * by credentials/setup.
 */
import { access, constants, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseSystemHealth, type SystemHealth } from "../lib/contracts";
import {
  getInstalledPluginPackagePath,
  loadShareConfig,
  type ShareConfig,
} from "../shared/config";
import {
  isLocalShareServerRunning,
  setupLocalRuntime,
  startLocalShareServer,
  stopLocalShareServer,
  uninstallLocalRuntime,
} from "./install";

const PLUGIN_GITHUB_REPO = "https://github.com/keihara-heidi/omp-sessions-share.git";
const PLUGIN_GITHUB_SOURCE = "github:keihara-heidi/omp-sessions-share";

export function parseMainCommit(output: string): string | null {
  return (
    output.trim().match(/^([0-9a-f]{40})\s+refs\/heads\/main$/)?.[1] ?? null
  );
}

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNHEALTHY = 3;

export type CliCommand =
  | { name: "help" }
  | { name: "setup" }
  | { name: "start" }
  | { name: "stop" }
  | { name: "restart" }
  | { name: "status" }
  | { name: "open" }
  | { name: "register"; path?: string }
  | { name: "credentials" }
  | { name: "logs"; follow: boolean }
  | { name: "update" }
  | { name: "uninstall" };

export type ParseResult =
  | { ok: true; command: CliCommand }
  | { ok: false; error: string; exitCode: number };

const COMMANDS = [
  "setup",
  "start",
  "stop",
  "restart",
  "status",
  "open",
  "register",
  "credentials",
  "logs",
  "update",
  "uninstall",
  "help",
] as const;

export const USAGE = `Usage: oss <command> [args]

Commands:
  setup                 Install/repair local daemon, Tailscale Serve, config, launchers
  start                 Start dashboard, show health, and follow API requests
  stop                  Stop dashboard daemon + Tailscale Serve
  restart               Restart dashboard daemon + Tailscale Serve
  status                Show URL, service state, and health checks
  open                  Open dashboard URL in the default browser
  register [path]       Register a workspace path (default: cwd)
  credentials           Print dashboard URL and password
  logs [--follow]       Show LaunchAgent daemon log (sanitized access lines)
  update                Install latest main, then refresh runtime without deleting local data
  uninstall             Remove local runtime state
  help                  Show this help

macOS + running Tailscale required for setup/start. Secrets are generated locally
and never accepted on argv. Dashboard lifecycle is terminal-owned; OMP only connects.
`;

function isForbiddenArg(arg: string): boolean {
  const lower = arg.toLowerCase();
  return (
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.startsWith("--host") ||
    lower.startsWith("--cookie")
  );
}

/** Deterministic argv parse for tests and dispatch. Does not run side effects. */
export function parseCliArgs(argv: readonly string[]): ParseResult {
  const args = argv.slice(2);
  if (args.some(isForbiddenArg)) {
    return {
      ok: false,
      error:
        "Refusing secret-like CLI flags. Setup generates secrets automatically.",
      exitCode: EXIT_USAGE,
    };
  }

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    if (args.length > 1 && args[0] === "help") {
      return {
        ok: false,
        error: "Unexpected arguments for help. Use: oss help",
        exitCode: EXIT_USAGE,
      };
    }
    return { ok: true, command: { name: "help" } };
  }

  const cmd = args[0]!;
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    return {
      ok: false,
      error: `Unknown command ${JSON.stringify(cmd)}. Use --help.`,
      exitCode: EXIT_USAGE,
    };
  }

  switch (cmd) {
    case "help":
      return { ok: true, command: { name: "help" } };
    case "setup":
    case "start":
    case "stop":
    case "restart":
    case "status":
    case "open":
    case "credentials":
    case "update":
    case "uninstall":
      if (args.length > 1) {
        return {
          ok: false,
          error: `Unexpected arguments for ${cmd}. Use: oss ${cmd}`,
          exitCode: EXIT_USAGE,
        };
      }
      return { ok: true, command: { name: cmd } };
    case "register": {
      if (args.length > 2) {
        return {
          ok: false,
          error: "Unexpected arguments for register. Use: oss register [path]",
          exitCode: EXIT_USAGE,
        };
      }
      return {
        ok: true,
        command: { name: "register", path: args[1] },
      };
    }
    case "logs": {
      if (args.length === 1) return { ok: true, command: { name: "logs", follow: false } };
      if (args.length === 2 && args[1] === "--follow") {
        return { ok: true, command: { name: "logs", follow: true } };
      }
      return {
        ok: false,
        error: "Unexpected arguments for logs. Use: oss logs [--follow]",
        exitCode: EXIT_USAGE,
      };
    }
    default:
      return {
        ok: false,
        error: `Unknown command ${JSON.stringify(cmd)}. Use --help.`,
        exitCode: EXIT_USAGE,
      };
  }
}

export function getDaemonLogPath(home = homedir()): string {
  return path.join(home, ".omp", "logs", "omp-sessions-share.log");
}

const ACCESS_LOG_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [A-Z]+ \/(?:healthz|api\/\S*) \d{3} \d+ms$/;

/** Only daemon-generated access lines; excludes startup/errors containing private paths. */
export function isAccessLogLine(line: string): boolean {
  return ACCESS_LOG_RE.test(line);
}

function printAccessLogText(text: string): void {
  const lines = text.split("\n").filter(isAccessLogLine);
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

async function pipeAccessLogs(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (isAccessLogLine(line)) console.log(line);
    }
    if (done) break;
  }
  if (isAccessLogLine(pending)) console.log(pending);
}

function fail(message: string, code = EXIT_RUNTIME): never {
  console.error(message);
  process.exit(code);
}

function printSetupResult(config: ShareConfig): void {
  console.log("omp-sessions-share setup complete.");
  console.log(`Dashboard (tailnet): ${config.publicOrigin}`);
  console.log(`Local origin:        ${config.localOrigin}`);
  console.log(`Config:              ~/.omp/agent/omp-sessions-share.json`);
  console.log(`Dashboard password:  ${config.dashboardPassword}`);
  console.log(
    "Installed launchers: ~/.local/bin/oss and ~/.local/bin/omp-share",
  );
  console.log(
    "OMP launcher:        ~/.local/bin/omp (existing installations are preserved)",
  );
  console.log(
    "Restart any already-open terminal or OMP session once so PATH picks up the launchers.",
  );
}

async function requireConfig(): Promise<ShareConfig> {
  const config = await loadShareConfig();
  if (!config) {
    fail(
      "Share config missing or invalid. Run: oss setup",
      EXIT_RUNTIME,
    );
  }
  return config;
}

async function cmdSetup(): Promise<void> {
  try {
    const config = await setupLocalRuntime();
    printSetupResult(config);
  } catch (err) {
    fail(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function cmdStart(): Promise<void> {
  const config = await requireConfig();
  try {
    await startLocalShareServer();
  } catch (err) {
    fail(`start failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let payload: HostHealthPayload | null = null;
  for (let attempt = 0; attempt < 20 && !payload; attempt++) {
    payload = await fetchHostHealth(config);
    if (!payload) await Bun.sleep(250);
  }
  if (!payload) fail("start failed: dashboard health endpoint did not become ready");

  console.log(`URL:     ${config.publicOrigin}`);
  console.log(`Local:   ${config.localOrigin}`);
  console.log("Service: running");
  printHostHealth(payload);
  console.log("Watching API requests. Ctrl-C stops this display; the dashboard stays running.");
  await cmdLogs(true, false);
}

async function cmdStop(): Promise<void> {
  try {
    await stopLocalShareServer();
    console.log("Dashboard stopped.");
  } catch (err) {
    fail(`stop failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdRestart(): Promise<void> {
  const config = await requireConfig();
  try {
    await stopLocalShareServer();
  } catch {
    // Best-effort stop before start.
  }
  try {
    await startLocalShareServer();
    console.log(`Dashboard restarted: ${config.publicOrigin}`);
  } catch (err) {
    fail(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type HostHealthPayload = {
  health: SystemHealth;
  liveSessions: number;
  recentSessions: number;
};

async function fetchHostHealth(
  config: ShareConfig,
): Promise<HostHealthPayload | null> {
  try {
    const res = await fetch(`${config.localOrigin}/api/host/system/health`, {
      headers: { authorization: `Bearer ${config.hostToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!body || typeof body !== "object" || !("data" in body)) return null;
    const data = body.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return null;
    const health = parseSystemHealth(data.health);
    if (!health) return null;
    const liveSessions =
      typeof data.liveSessions === "number" &&
      Number.isInteger(data.liveSessions) &&
      data.liveSessions >= 0
        ? data.liveSessions
        : 0;
    const recentSessions =
      typeof data.recentSessions === "number" &&
      Number.isInteger(data.recentSessions) &&
      data.recentSessions >= 0
        ? data.recentSessions
        : 0;
    return { health, liveSessions, recentSessions };
  } catch {
    return null;
  }
}

function printHostHealth(payload: HostHealthPayload): void {
  const { health, liveSessions, recentSessions } = payload;
  console.log(`Overall: ${health.overall}`);
  console.log(`Live:    ${liveSessions}`);
  console.log(`Recent:  ${recentSessions}`);
  console.log("Checks:");
  for (const check of health.checks) {
    const action = check.action ? ` — ${check.action}` : "";
    console.log(`  ${check.level.padEnd(11)} ${check.label}: ${check.summary}${action}`);
  }
}

async function cmdStatus(): Promise<void> {
  const config = await requireConfig();
  const running = isLocalShareServerRunning();
  const payload = running ? await fetchHostHealth(config) : null;

  console.log(`URL:     ${config.publicOrigin}`);
  console.log(`Local:   ${config.localOrigin}`);
  console.log(`Service: ${running ? "running" : "stopped"}`);

  if (!running) {
    console.log("Health:  unavailable (daemon not loaded)");
    console.log("Run: oss start");
    process.exit(EXIT_UNHEALTHY);
  }

  if (!payload) {
    console.log("Health:  unavailable (host health endpoint unreachable)");
    process.exit(EXIT_UNHEALTHY);
  }

  printHostHealth(payload);

  if (payload.health.overall !== "healthy") {
    process.exit(EXIT_UNHEALTHY);
  }
}

async function cmdOpen(): Promise<void> {
  const config = await requireConfig();
  const result = Bun.spawnSync(["open", config.publicOrigin], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const err = new TextDecoder().decode(result.stderr).trim();
    fail(`open failed: ${err || `exit ${result.exitCode}`}`);
  }
  console.log(`Opened ${config.publicOrigin}`);
}

async function cmdRegister(requestedPath?: string): Promise<void> {
  const config = await requireConfig();
  const target = path.resolve(process.cwd(), requestedPath ?? ".");
  let absolute: string;
  try {
    absolute = await realpath(target);
  } catch {
    fail(`register failed: path not found: ${target}`);
  }

  try {
    const res = await fetch(`${config.localOrigin}/api/host/locations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.hostToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: absolute }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (typeof body.error === "string" && body.error) detail = body.error;
      } catch {
        // keep status text
      }
      fail(`register failed: ${detail}`);
    }
    const body = (await res.json()) as {
      data?: { locations?: Array<{ worktree?: { path?: string } }> };
    };
    const locations = body.data?.locations ?? [];
    console.log(`Registered ${absolute}`);
    if (locations.length > 0) {
      for (const loc of locations) {
        const p = loc.worktree?.path;
        if (typeof p === "string" && p) console.log(`  ${p}`);
      }
    }
  } catch (err) {
    fail(
      `register failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function cmdCredentials(): Promise<void> {
  const config = await requireConfig();
  console.log(`URL:      ${config.publicOrigin}`);
  console.log(`Password: ${config.dashboardPassword}`);
}

async function cmdLogs(follow: boolean, includeExisting = true): Promise<void> {
  const logPath = getDaemonLogPath();
  try {
    await access(logPath, constants.R_OK);
  } catch {
    fail(
      `Log file not found at ${logPath}. Start the dashboard once with: oss start`,
    );
  }

  if (follow) {
    const proc = Bun.spawn(["tail", "-n", includeExisting ? "+1" : "0", "-F", logPath], {
      stdout: "pipe",
      stderr: "inherit",
      stdin: "ignore",
    });
    await pipeAccessLogs(proc.stdout);
    const code = await proc.exited;
    process.exit(code === 0 ? EXIT_OK : EXIT_RUNTIME);
  }

  printAccessLogText(await Bun.file(logPath).text());
}

async function resolveInstalledSetupEntry(): Promise<string> {
  const pkgPath = getInstalledPluginPackagePath();
  try {
    await stat(pkgPath);
  } catch {
    fail(
      "Installed plugin package not found. Run: omp plugin install github:keihara-heidi/omp-sessions-share",
    );
  }
  const entry = path.join(path.dirname(pkgPath), "setup", "cli.ts");
  try {
    await access(entry, constants.R_OK);
  } catch {
    fail(`Installed setup entry missing: ${entry}`);
  }
  return entry;
}

async function cmdUpdate(): Promise<void> {
  const remote = Bun.spawnSync(
    ["git", "ls-remote", PLUGIN_GITHUB_REPO, "refs/heads/main"],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const commit =
    remote.exitCode === 0 ? parseMainCommit(remote.stdout.toString()) : null;
  if (!commit) {
    const detail = remote.stderr.toString().trim();
    fail(`update failed: could not resolve latest main commit${detail ? `: ${detail}` : ""}`);
  }

  const upgrade = Bun.spawnSync(
    ["omp", "plugin", "install", `${PLUGIN_GITHUB_SOURCE}#${commit}`, "--force"],
    {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    },
  );
  if (upgrade.exitCode !== 0) {
    fail(
      `update failed: omp plugin install exited ${upgrade.exitCode ?? "unknown"}`,
    );
  }

  const setupEntry = await resolveInstalledSetupEntry();
  const setup = Bun.spawnSync(["bun", setupEntry, "setup"], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  if (setup.exitCode !== 0) {
    fail(
      `update failed: installed setup exited ${setup.exitCode ?? "unknown"}`,
    );
  }
  console.log(
    "omp-sessions-share update complete. Local config and database preserved.",
  );
}

async function cmdUninstall(): Promise<void> {
  try {
    await uninstallLocalRuntime();
    console.log("omp-sessions-share local runtime removed.");
  } catch (err) {
    fail(
      `uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(parsed.exitCode);
  }

  switch (parsed.command.name) {
    case "help":
      console.log(USAGE);
      return;
    case "setup":
      await cmdSetup();
      return;
    case "start":
      await cmdStart();
      return;
    case "stop":
      await cmdStop();
      return;
    case "restart":
      await cmdRestart();
      return;
    case "status":
      await cmdStatus();
      return;
    case "open":
      await cmdOpen();
      return;
    case "register":
      await cmdRegister(parsed.command.path);
      return;
    case "credentials":
      await cmdCredentials();
      return;
    case "logs":
      await cmdLogs(parsed.command.follow);
      return;
    case "update":
      await cmdUpdate();
      return;
    case "uninstall":
      await cmdUninstall();
      return;
  }
}

// Avoid executing when imported by tests.
const isDirectRun =
  typeof Bun !== "undefined" &&
  Bun.main &&
  path.resolve(Bun.main) === path.resolve(import.meta.path);

if (isDirectRun) {
  try {
    await runCli(process.argv);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
