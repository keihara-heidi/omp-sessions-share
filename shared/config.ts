/** Local daemon share config — ~/.omp/agent/omp-sessions-share.json (mode 0600). */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SHARE_CONFIG_VERSION = 1 as const;
export const DEFAULT_LOCAL_ORIGIN = "http://127.0.0.1:7466";
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 7466;

export type ShareConfig = {
  version: 1;
  localOrigin: string;
  publicOrigin: string;
  hostToken: string;
  dashboardPassword: string;
  cookieSecret: string;
};

const ORIGIN_RE = /^https?:\/\/[^\s/]+$/i;
const SECRET_MIN = 16;
const SECRET_MAX = 512;

function agentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".omp", "agent");
}

/** Absolute path to the share config JSON. */
export function getShareConfigPath(root = agentDir()): string {
  return join(root, "omp-sessions-share.json");
}

/** Persistent dashboard locations stored beside the private share config. */
export function getDashboardLocationsPath(root = agentDir()): string {
  return join(root, "omp-sessions-share-locations.json");
}

/** Private dashboard SQLite DB path (locations + session resumes). */
export function getDashboardDbPath(root = agentDir()): string {
  return join(root, "omp-sessions-share.sqlite");
}

/**
 * Fixed installed-plugin package manifest path (agent-relative).
 * Never accepts arbitrary paths — always `../plugins/node_modules/omp-sessions-share/package.json`.
 */
export function getInstalledPluginPackagePath(root = agentDir()): string {
  return join(
    root,
    "..",
    "plugins",
    "node_modules",
    "omp-sessions-share",
    "package.json",
  );
}

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function isSecret(v: unknown): v is string {
  return (
    typeof v === "string" && v.length >= SECRET_MIN && v.length <= SECRET_MAX
  );
}

function isHttpOrigin(v: unknown): v is string {
  if (!isNonEmptyString(v, 512) || !ORIGIN_RE.test(v)) return false;
  try {
    const u = new URL(v);
    if (u.username || u.password || u.search || u.hash) return false;
    if (u.pathname !== "/" && u.pathname !== "") return false;
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalOrigin(v: unknown): v is string {
  return isHttpOrigin(v) && new URL(v).origin === DEFAULT_LOCAL_ORIGIN;
}

function isTailnetOrigin(v: unknown): v is string {
  if (!isHttpOrigin(v)) return false;
  const url = new URL(v);
  return (
    url.protocol === "https:" &&
    url.hostname.endsWith(".ts.net") &&
    url.port === "8443"
  );
}

/** Validate unknown JSON into ShareConfig; null when invalid. */
export function parseShareConfig(value: unknown): ShareConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const o = value as Record<string, unknown>;
  if (o.version !== SHARE_CONFIG_VERSION) return null;
  if (!isLocalOrigin(o.localOrigin)) return null;
  if (!isTailnetOrigin(o.publicOrigin)) return null;
  if (!isSecret(o.hostToken)) return null;
  if (!isSecret(o.dashboardPassword)) return null;
  if (!isSecret(o.cookieSecret)) return null;
  const localOrigin = new URL(o.localOrigin).origin;
  const publicOrigin = new URL(o.publicOrigin).origin;
  return {
    version: 1,
    localOrigin,
    publicOrigin,
    hostToken: o.hostToken,
    dashboardPassword: o.dashboardPassword,
    cookieSecret: o.cookieSecret,
  };
}

/** Read + validate config from disk; null if missing or invalid. */
export async function loadShareConfig(
  path = getShareConfigPath(),
): Promise<ShareConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    return parseShareConfig(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function loadShareConfigOrThrow(
  path = getShareConfigPath(),
): Promise<ShareConfig> {
  const cfg = await loadShareConfig(path);
  if (!cfg) {
    throw new Error(`missing or invalid share config at ${path}`);
  }
  return cfg;
}

/** Write config with mode 0600; creates parent dirs as needed. */
export async function writeShareConfig(
  config: ShareConfig,
  path = getShareConfigPath(),
): Promise<void> {
  const parsed = parseShareConfig(config);
  if (!parsed) throw new Error("invalid share config");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

/** Parse listen host/port from localOrigin (defaults 127.0.0.1:7466). */
export function listenEndpoint(config: ShareConfig): {
  hostname: string;
  port: number;
} {
  const u = new URL(config.localOrigin);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("localOrigin port out of range");
  }
  const hostname = u.hostname || DEFAULT_LISTEN_HOST;
  return { hostname, port };
}
