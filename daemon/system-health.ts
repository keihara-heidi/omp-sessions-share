/** Read-only system health probes for the local dashboard. */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type HealthCheck,
  type HealthCheckId,
  type HealthLevel,
  type SystemHealth,
  HEALTH_CHECK_IDS,
  nowIso,
  overallHealthLevel,
} from "../lib/contracts";
import { getInstalledPluginPackagePath } from "../shared/config";
import { resolveGhBin } from "./github-pr";
import { probeDashboardDbHealth } from "./store";

const CACHE_TTL_MS = 20_000;
const CMD_TIMEOUT_MS = 3_000;
const MAX_CMD_OUTPUT_BYTES = 1024 * 1024;
const MAX_SERVE_OUTPUT_BYTES = 256 * 1024;
const MAX_PKG_BYTES = 16_384;
const LAUNCHER_MARKER = "omp-sessions-share-owned-launcher";
const PACKAGE_NAME = "omp-sessions-share";
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const LABELS: Record<HealthCheckId, string> = {
  daemon: "Daemon",
  "runtime-version": "Runtime version",
  database: "Database",
  "tailscale-serve": "Tailscale Serve",
  "dashboard-ingress": "Dashboard ingress",
  omp: "OMP launcher",
  "dashboard-omp": "Dashboard OMP launcher",
  "github-cli": "GitHub CLI",
  "sleep-inhibitor": "Sleep inhibitor",
};

export type SystemHealthServiceOptions = {
  isSleepInhibitorActive: () => boolean;
  isSleepInhibitorRequired: () => boolean;
  /** Optional test seams */
  probeDatabase?: () => "healthy" | "unavailable";
  probes?: Partial<Record<HealthCheckId, HealthProbe>>;
  now?: () => number;
  runtimePackagePath?: string;
  installedPackagePath?: string;
  localBinDir?: string;
  dashboardOmpPath?: string;
};

export type SystemHealthService = {
  getHealth: () => Promise<SystemHealth>;
};

type BoundedRun = {
  code: number;
  stdout: string;
};

type HealthProbe = (checkedAt: string) => HealthCheck | Promise<HealthCheck>;

type HealthSubprocess = Bun.Subprocess<"ignore", "pipe", "ignore">;

function checkOf(
  id: HealthCheckId,
  level: HealthLevel,
  summary: string,
  checkedAt: string,
  action?: string,
): HealthCheck {
  const check: HealthCheck = {
    id,
    label: LABELS[id],
    level,
    summary,
    checkedAt,
  };
  if (action) check.action = action;
  return check;
}

function soft(
  id: HealthCheckId,
  checkedAt: string,
  run: () => HealthCheck | Promise<HealthCheck>,
  fallback: HealthCheck,
): Promise<HealthCheck> {
  return Promise.resolve()
    .then(run)
    .catch(() => fallback)
    .then((check) => {
      // Defensive: never let a probe return a different id or leaky empty fields.
      if (check.id !== id || !check.summary || !check.label) return fallback;
      return check;
    });
}

async function runBounded(
  argv: readonly string[],
  opts: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<BoundedRun | null> {
  const timeoutMs = opts.timeoutMs ?? CMD_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_CMD_OUTPUT_BYTES;
  if (argv.length === 0 || !argv[0]) return null;

  let proc: HealthSubprocess;
  try {
    proc = Bun.spawn(argv.slice(), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
  } catch {
    return null;
  }

  let failed = false;
  const stop = () => {
    failed = true;
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };
  const timer = setTimeout(stop, timeoutMs);

  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxOutputBytes) {
        stop();
        break;
      }
      chunks.push(value);
    }
    const code = await proc.exited;
    if (failed) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { code: code ?? 1, stdout: new TextDecoder().decode(bytes) };
  } catch {
    stop();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function resolveTailscaleBin(): string | null {
  const candidates = [
    Bun.which("tailscale"),
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      // missing or not executable
    }
  }
  return null;
}

function readOwnedMarker(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size <= 0 || st.size > 8_192) return false;
    const body = readFileSync(filePath, "utf8");
    return body.includes(LAUNCHER_MARKER);
  } catch {
    return false;
  }
}

function pathExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPackageVersion(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_PKG_BYTES) return null;
    const text = readFileSync(filePath, "utf8");
    if (text.length > MAX_PKG_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const o = parsed as Record<string, unknown>;
    if (o.name !== PACKAGE_NAME) return null;
    if (
      typeof o.version !== "string" ||
      o.version.length > 64 ||
      !VERSION_RE.test(o.version)
    )
      return null;
    return o.version;
  } catch {
    return null;
  }
}

function parseOmpVersion(stdout: string): string | null {
  const match = /^omp\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m.exec(stdout);
  return match?.[1] ?? null;
}

function probeDaemon(checkedAt: string): HealthCheck {
  const uptimeSec = Math.max(0, Math.floor(process.uptime()));
  let uptimeSummary: string;
  if (uptimeSec < 60) {
    uptimeSummary = "up for under a minute";
  } else if (uptimeSec < 3600) {
    const m = Math.floor(uptimeSec / 60);
    uptimeSummary = m === 1 ? "up for 1 minute" : `up for ${m} minutes`;
  } else if (uptimeSec < 86400) {
    const h = Math.floor(uptimeSec / 3600);
    uptimeSummary = h === 1 ? "up for 1 hour" : `up for ${h} hours`;
  } else {
    const d = Math.floor(uptimeSec / 86400);
    uptimeSummary = d === 1 ? "up for 1 day" : `up for ${d} days`;
  }
  return checkOf(
    "daemon",
    "healthy",
    `Listening on loopback and serving requests (${uptimeSummary})`,
    checkedAt,
  );
}

function probeRuntimeVersion(
  checkedAt: string,
  runtimePackagePath: string,
  installedPackagePath: string,
): HealthCheck {
  const runtimeVersion = readPackageVersion(runtimePackagePath);
  if (!runtimeVersion) {
    return checkOf(
      "runtime-version",
      "warning",
      "Runtime package version is unavailable",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  const installedVersion = readPackageVersion(installedPackagePath);
  if (!installedVersion) {
    return checkOf(
      "runtime-version",
      "warning",
      "Installed plugin version is unavailable",
      checkedAt,
      "Reinstall the plugin package",
    );
  }
  if (runtimeVersion === installedVersion) {
    return checkOf(
      "runtime-version",
      "healthy",
      `Plugin and runtime both ${runtimeVersion}`,
      checkedAt,
    );
  }
  return checkOf(
    "runtime-version",
    "warning",
    `Plugin ${installedVersion}, runtime ${runtimeVersion}`,
    checkedAt,
    "Re-run plugin setup",
  );
}

function probeDatabase(
  checkedAt: string,
  probe: () => "healthy" | "unavailable",
): HealthCheck {
  const level = probe();
  if (level === "healthy") {
    return checkOf(
      "database",
      "healthy",
      "Open with the expected schema and readable",
      checkedAt,
    );
  }
  return checkOf(
    "database",
    "unavailable",
    "Database is not ready",
    checkedAt,
    "Restart the dashboard daemon",
  );
}

async function probeTailscale(checkedAt: string): Promise<HealthCheck> {
  const bin = resolveTailscaleBin();
  if (!bin) {
    return checkOf(
      "tailscale-serve",
      "unavailable",
      "Tailscale CLI is not available",
      checkedAt,
      "Install Tailscale and sign in",
    );
  }
  const result = await runBounded([bin, "status", "--json"], {
    timeoutMs: CMD_TIMEOUT_MS,
    maxOutputBytes: MAX_CMD_OUTPUT_BYTES,
  });
  if (!result || result.code !== 0) {
    return checkOf(
      "tailscale-serve",
      "unavailable",
      "Tailscale status could not be read",
      checkedAt,
      "Open Tailscale and sign in",
    );
  }
  let backendState: string | undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const state = (parsed as Record<string, unknown>).BackendState;
      if (typeof state === "string" && state.length > 0 && state.length <= 64) {
        backendState = state;
      }
    }
  } catch {
    return checkOf(
      "tailscale-serve",
      "unavailable",
      "Tailscale status could not be read",
      checkedAt,
      "Open Tailscale and sign in",
    );
  }
  if (backendState === "Running") {
    return checkOf(
      "tailscale-serve",
      "healthy",
      "Tailscale backend is running",
      checkedAt,
    );
  }
  return checkOf(
    "tailscale-serve",
    "unavailable",
    "Tailscale backend is not running",
    checkedAt,
    "Open Tailscale and sign in",
  );
}

async function probeDashboardIngress(checkedAt: string): Promise<HealthCheck> {
  const bin = resolveTailscaleBin();
  if (!bin) {
    return checkOf(
      "dashboard-ingress",
      "unavailable",
      "Tailscale Serve configuration is unavailable",
      checkedAt,
      "Install Tailscale and re-run plugin setup",
    );
  }
  const result = await runBounded([bin, "serve", "status", "--json"], {
    timeoutMs: CMD_TIMEOUT_MS,
    maxOutputBytes: MAX_SERVE_OUTPUT_BYTES,
  });
  if (!result || result.code !== 0) {
    return checkOf(
      "dashboard-ingress",
      "unavailable",
      "Tailscale Serve configuration could not be read",
      checkedAt,
      "Re-run plugin setup",
    );
  }

  let configured = false;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      const tcp = root.TCP;
      const web = root.Web;
      const https =
        tcp && typeof tcp === "object" && !Array.isArray(tcp)
          ? (tcp as Record<string, unknown>)["8443"]
          : undefined;
      const hasHttps =
        https && typeof https === "object" && !Array.isArray(https)
          ? (https as Record<string, unknown>).HTTPS === true
          : false;
      let hasProxy = false;
      if (web && typeof web === "object" && !Array.isArray(web)) {
        for (const host of Object.values(web as Record<string, unknown>)) {
          if (!host || typeof host !== "object" || Array.isArray(host))
            continue;
          const handlers = (host as Record<string, unknown>).Handlers;
          if (
            !handlers ||
            typeof handlers !== "object" ||
            Array.isArray(handlers)
          )
            continue;
          for (const handler of Object.values(
            handlers as Record<string, unknown>,
          )) {
            if (
              !handler ||
              typeof handler !== "object" ||
              Array.isArray(handler)
            )
              continue;
            if (
              (handler as Record<string, unknown>).Proxy ===
              "http://127.0.0.1:7466"
            ) {
              hasProxy = true;
              break;
            }
          }
          if (hasProxy) break;
        }
      }
      configured = Boolean(hasHttps && hasProxy);
    }
  } catch {
    configured = false;
  }

  if (configured) {
    return checkOf(
      "dashboard-ingress",
      "healthy",
      "Tailnet HTTPS forwards to the loopback dashboard",
      checkedAt,
    );
  }
  return checkOf(
    "dashboard-ingress",
    "unavailable",
    "Tailscale Serve is not forwarding to the dashboard",
    checkedAt,
    "Re-run plugin setup",
  );
}

async function probeOmpLauncher(
  checkedAt: string,
  localBinDir: string,
): Promise<HealthCheck> {
  const ompPath = join(localBinDir, "omp");
  try {
    const st = statSync(ompPath);
    if (!st.isFile()) {
      return checkOf(
        "omp",
        "warning",
        "Managed OMP launcher is missing",
        checkedAt,
        "Re-run plugin setup",
      );
    }
  } catch {
    return checkOf(
      "omp",
      "warning",
      "Managed OMP launcher is missing",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  if (!readOwnedMarker(ompPath)) {
    return checkOf(
      "omp",
      "warning",
      "OMP launcher is present but not managed by this plugin",
      checkedAt,
      "Move the existing launcher aside and re-run setup",
    );
  }
  if (!pathExecutable(ompPath)) {
    return checkOf(
      "omp",
      "warning",
      "Managed OMP launcher is not executable",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  const result = await runBounded([ompPath, "--version"], {
    timeoutMs: CMD_TIMEOUT_MS,
    maxOutputBytes: 4_096,
  });
  const version =
    result && result.code === 0 ? parseOmpVersion(result.stdout) : null;
  if (!version) {
    return checkOf(
      "omp",
      "warning",
      "Managed OMP launcher did not report a version",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  return checkOf(
    "omp",
    "healthy",
    `Managed OMP launcher uses OMP ${version}`,
    checkedAt,
  );
}

async function probeDashboardOmpLauncher(
  checkedAt: string,
  launcherPath: string,
): Promise<HealthCheck> {
  try {
    const st = statSync(launcherPath);
    if (!st.isFile()) {
      return checkOf(
        "dashboard-omp",
        "warning",
        "Dashboard OMP launcher is missing",
        checkedAt,
        "Re-run plugin setup",
      );
    }
  } catch {
    return checkOf(
      "dashboard-omp",
      "warning",
      "Dashboard OMP launcher is missing",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  if (!readOwnedMarker(launcherPath)) {
    return checkOf(
      "dashboard-omp",
      "warning",
      "Dashboard OMP launcher is not managed by this plugin",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  if (!pathExecutable(launcherPath)) {
    return checkOf(
      "dashboard-omp",
      "warning",
      "Dashboard OMP launcher is not executable",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  const result = await runBounded([launcherPath, "--version"], {
    timeoutMs: CMD_TIMEOUT_MS,
    maxOutputBytes: 4_096,
  });
  if (!result || result.code !== 0) {
    return checkOf(
      "dashboard-omp",
      "warning",
      "Dashboard OMP launcher did not report a version",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  const version = parseOmpVersion(result.stdout);
  if (!version) {
    return checkOf(
      "dashboard-omp",
      "warning",
      "Dashboard OMP launcher reported an invalid version",
      checkedAt,
      "Re-run plugin setup",
    );
  }
  return checkOf(
    "dashboard-omp",
    "healthy",
    `Dashboard OMP launcher uses OMP ${version}`,
    checkedAt,
  );
}

async function probeGithubCli(checkedAt: string): Promise<HealthCheck> {
  const bin = resolveGhBin();
  if (!bin) {
    return checkOf(
      "github-cli",
      "warning",
      "GitHub CLI is not available",
      checkedAt,
      "Install GitHub CLI and sign in",
    );
  }
  const result = await runBounded(
    [bin, "auth", "status", "--hostname", "github.com", "--active"],
    {
      timeoutMs: CMD_TIMEOUT_MS,
      maxOutputBytes: 8_192,
      env: {
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (!result || result.code !== 0) {
    return checkOf(
      "github-cli",
      "warning",
      "GitHub CLI is not authenticated for github.com",
      checkedAt,
      "Run gh auth login for github.com",
    );
  }
  return checkOf(
    "github-cli",
    "healthy",
    "GitHub CLI is authenticated for github.com",
    checkedAt,
  );
}

function probeSleepInhibitor(
  checkedAt: string,
  isActive: () => boolean,
  isRequired: () => boolean,
): HealthCheck {
  const required = isRequired();
  const active = isActive();
  if (!required) {
    return checkOf(
      "sleep-inhibitor",
      "healthy",
      active ? "Active while no live sessions require it" : "Not required",
      checkedAt,
    );
  }
  if (active) {
    return checkOf(
      "sleep-inhibitor",
      "healthy",
      "Holding sleep assertion for live sessions",
      checkedAt,
    );
  }
  return checkOf(
    "sleep-inhibitor",
    "warning",
    "Live sessions are present but sleep inhibition is inactive",
    checkedAt,
    "Keep the Mac awake and restart sharing from OMP",
  );
}

export function createSystemHealthService(
  options: SystemHealthServiceOptions,
): SystemHealthService {
  const runtimePackagePath =
    options.runtimePackagePath ?? join(import.meta.dir, "..", "package.json");
  const installedPackagePath =
    options.installedPackagePath ?? getInstalledPluginPackagePath();
  const localBinDir =
    options.localBinDir ??
    join(process.env.HOME?.trim() || homedir(), ".local", "bin");
  const dashboardOmpPath =
    options.dashboardOmpPath ?? join(import.meta.dir, "..", "omp");
  const probeDatabaseFn = options.probeDatabase ?? probeDashboardDbHealth;
  const nowFn = options.now ?? Date.now;

  let cached: { value: SystemHealth; expiresAt: number } | undefined;
  let inflight: Promise<SystemHealth> | undefined;

  async function collect(): Promise<SystemHealth> {
    const checkedAt = new Date(nowFn()).toISOString();
    const unknown = (id: HealthCheckId): HealthCheck =>
      checkOf(id, "unknown", "Health check did not complete", checkedAt);
    const runProbe = (
      id: HealthCheckId,
      probe: HealthProbe,
      fallback: HealthCheck = unknown(id),
    ) =>
      soft(
        id,
        checkedAt,
        () => (options.probes?.[id] ?? probe)(checkedAt),
        fallback,
      );

    const checks = await Promise.all([
      runProbe("daemon", () => probeDaemon(checkedAt)),
      runProbe("runtime-version", () =>
        probeRuntimeVersion(
          checkedAt,
          runtimePackagePath,
          installedPackagePath,
        ),
      ),
      runProbe(
        "database",
        () => probeDatabase(checkedAt, probeDatabaseFn),
        checkOf(
          "database",
          "unavailable",
          "Database is not ready",
          checkedAt,
          "Restart the dashboard daemon",
        ),
      ),
      runProbe(
        "tailscale-serve",
        () => probeTailscale(checkedAt),
        checkOf(
          "tailscale-serve",
          "unavailable",
          "Tailscale status could not be read",
          checkedAt,
          "Open Tailscale and sign in",
        ),
      ),
      runProbe(
        "dashboard-ingress",
        () => probeDashboardIngress(checkedAt),
        checkOf(
          "dashboard-ingress",
          "unavailable",
          "Dashboard ingress is not reachable",
          checkedAt,
          "Check Tailscale Serve and the daemon",
        ),
      ),
      runProbe("omp", () => probeOmpLauncher(checkedAt, localBinDir)),
      runProbe("dashboard-omp", () =>
        probeDashboardOmpLauncher(checkedAt, dashboardOmpPath),
      ),
      runProbe("github-cli", () => probeGithubCli(checkedAt)),
      runProbe("sleep-inhibitor", () =>
        probeSleepInhibitor(
          checkedAt,
          options.isSleepInhibitorActive,
          options.isSleepInhibitorRequired,
        ),
      ),
    ]);

    const byId = new Map(checks.map((check) => [check.id, check]));
    const ordered = HEALTH_CHECK_IDS.map((id) => byId.get(id) ?? unknown(id));
    return {
      overall: overallHealthLevel(ordered.map((check) => check.level)),
      checkedAt,
      checks: ordered,
    };
  }

  async function getHealth(): Promise<SystemHealth> {
    const now = nowFn();
    if (cached && cached.expiresAt > now) return cached.value;
    if (inflight) return inflight;

    const pending = collect()
      .then((value) => {
        cached = { value, expiresAt: nowFn() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        if (inflight === pending) inflight = undefined;
      });
    inflight = pending;
    return pending;
  }

  return { getHealth };
}
