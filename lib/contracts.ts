/** Shared API contracts — never includes plaintext collab links. */

export type SessionGroupKind = "repository" | "folder";
export type SessionOrigin = "workspace" | "adhoc";

export type SessionGroup = {
  kind: SessionGroupKind;
  name: string;
  path: string;
};

export type SessionWorktree = {
  name: string;
  path: string;
  branch?: string;
};

export type SessionSummary = {
  origin: SessionOrigin;
  id: string;
  title: string;
  cwd: string;
  startedAt: string;
  lastSeenAt: string;
  group: SessionGroup;
  worktree: SessionWorktree;
};

/** Public recent-session row — never includes host-only sessionFile. */
export type RecentSessionSummary = {
  origin: SessionOrigin;
  id: string;
  title: string;
  lastSeenAt: string;
  group: SessionGroup;
  worktree: SessionWorktree;
};

/** A worktree remembered by the dashboard even when it has no live sessions. */
export type DashboardLocation = {
  group: SessionGroup;
  worktree: SessionWorktree;
  lastSessionStartedAt: string;
};

export type SessionDashboard = {
  sessions: SessionSummary[];
  locations: DashboardLocation[];
  recentSessions: RecentSessionSummary[];
  /** Absolute repository group paths marked favorite; order is insignificant. */
  favoriteRepositoryPaths: string[];
};

export type JoinRequestStatus = "pending" | "approved" | "denied" | "expired";

export type JoinRequest = {
  id: string;
  sessionId: string;
  deviceName: string;
  publicKeyJwk: JsonWebKey;
  createdAt: string;
  status: JoinRequestStatus;
};

/** RSA-OAEP ciphertext only — server never sees plaintext collab URL. */
export type EncryptedLink = {
  algorithm: "RSA-OAEP-256";
  ciphertext: string;
};

export type JoinRequestResult = JoinRequest & {
  encryptedLink?: EncryptedLink;
};

export type ApiOk<T> = { data: T };
export type ApiErr = { error: string };
export type ApiResult<T> = ApiOk<T> | ApiErr;

export type HealthLevel = "healthy" | "warning" | "unavailable" | "unknown";

export type HealthCheckId =
  | "daemon"
  | "runtime-version"
  | "database"
  | "tailscale-serve"
  | "dashboard-ingress"
  | "omp"
  | "dashboard-omp"
  | "github-cli"
  | "sleep-inhibitor";

export type HealthCheck = {
  id: HealthCheckId;
  label: string;
  level: HealthLevel;
  summary: string;
  checkedAt: string;
  action?: string;
};

export type SystemHealth = {
  overall: HealthLevel;
  checkedAt: string;
  checks: HealthCheck[];
};

export type PluginUpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  commit: string;
  updateAvailable: boolean;
};

export function parsePluginUpdateStatus(v: unknown): PluginUpdateStatus | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.currentVersion !== "string" || o.currentVersion.length > 64)
    return null;
  if (typeof o.latestVersion !== "string" || o.latestVersion.length > 64)
    return null;
  if (typeof o.commit !== "string" || !/^[0-9a-f]{40}$/.test(o.commit))
    return null;
  if (typeof o.updateAvailable !== "boolean") return null;
  if (o.updateAvailable !== (o.currentVersion !== o.latestVersion)) return null;
  return {
    currentVersion: o.currentVersion,
    latestVersion: o.latestVersion,
    commit: o.commit,
    updateAvailable: o.updateAvailable,
  };
}

export const HEALTH_CHECK_IDS = [
  "daemon",
  "runtime-version",
  "database",
  "tailscale-serve",
  "dashboard-ingress",
  "omp",
  "dashboard-omp",
  "github-cli",
  "sleep-inhibitor",
] as const satisfies readonly HealthCheckId[];

const HEALTH_LEVEL_RANK: Record<HealthLevel, number> = {
  unavailable: 0,
  warning: 1,
  unknown: 2,
  healthy: 3,
};

const HEALTH_CHECK_ID_SET: Record<string, true> = {
  daemon: true,
  "runtime-version": true,
  database: true,
  "tailscale-serve": true,
  "dashboard-ingress": true,
  omp: true,
  "dashboard-omp": true,
  "github-cli": true,
  "sleep-inhibitor": true,
};

const HEALTH_LABEL_MAX = 64;
const HEALTH_SUMMARY_MAX = 256;
const HEALTH_ACTION_MAX = 128;

export function isHealthLevel(v: unknown): v is HealthLevel {
  return (
    v === "healthy" || v === "warning" || v === "unavailable" || v === "unknown"
  );
}

export function isHealthCheckId(v: unknown): v is HealthCheckId {
  return typeof v === "string" && HEALTH_CHECK_ID_SET[v] === true;
}

/** Deterministic rollup: unavailable > warning > unknown > healthy. */
export function overallHealthLevel(
  levels: readonly HealthLevel[],
): HealthLevel {
  let best: HealthLevel = "healthy";
  let bestRank = HEALTH_LEVEL_RANK.healthy;
  for (const level of levels) {
    const rank = HEALTH_LEVEL_RANK[level];
    if (rank < bestRank) {
      best = level;
      bestRank = rank;
    }
  }
  return best;
}

export function parseHealthCheck(v: unknown): HealthCheck | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isHealthCheckId(o.id)) return null;
  if (!isNonEmptyString(o.label, HEALTH_LABEL_MAX)) return null;
  if (!isHealthLevel(o.level)) return null;
  if (!isNonEmptyString(o.summary, HEALTH_SUMMARY_MAX)) return null;
  if (!isIsoTimestamp(o.checkedAt)) return null;
  if (
    o.action !== undefined &&
    !isNonEmptyString(o.action, HEALTH_ACTION_MAX)
  ) {
    return null;
  }
  const check: HealthCheck = {
    id: o.id,
    label: o.label,
    level: o.level,
    summary: o.summary,
    checkedAt: o.checkedAt,
  };
  if (typeof o.action === "string") check.action = o.action;
  return check;
}

export function parseSystemHealth(v: unknown): SystemHealth | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isHealthLevel(o.overall)) return null;
  if (!isIsoTimestamp(o.checkedAt)) return null;
  if (!Array.isArray(o.checks) || o.checks.length !== HEALTH_CHECK_IDS.length) {
    return null;
  }
  const checks: HealthCheck[] = [];
  const seen = new Set<HealthCheckId>();
  for (const item of o.checks) {
    const check = parseHealthCheck(item);
    if (!check) return null;
    if (seen.has(check.id)) return null;
    seen.add(check.id);
    checks.push(check);
  }
  for (const id of HEALTH_CHECK_IDS) {
    if (!seen.has(id)) return null;
  }
  const overall = overallHealthLevel(checks.map((c) => c.level));
  if (overall !== o.overall) return null;
  return {
    overall,
    checkedAt: o.checkedAt,
    checks,
  };
}

export const SESSION_TTL_SECONDS = 15;
export const REQUEST_TTL_SECONDS = 5 * 60;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth"] as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function isNonEmptyString(v: unknown, max = 512): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

export function isValidId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

export function isIsoTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_RE.test(v)) return false;
  return Number.isFinite(Date.parse(v));
}

export function isJoinRequestStatus(v: unknown): v is JoinRequestStatus {
  return (
    v === "pending" || v === "approved" || v === "denied" || v === "expired"
  );
}

/**
 * RSA public JWK for RSA-OAEP-256.
 * Requires kty=RSA, n/e strings; rejects private fields.
 * alg may be absent or RSA-OAEP-256 (RSA-OAEP accepted as alias).
 * key_ops if present may only include "encrypt"; use if present must be "enc".
 */
export function isValidPublicKeyJwk(v: unknown): v is JsonWebKey {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const j = v as Record<string, unknown>;
  if (j.kty !== "RSA") return false;
  if (typeof j.n !== "string" || j.n.length < 342 || j.n.length > 1024)
    return false;
  if (typeof j.e !== "string" || j.e.length < 1 || j.e.length > 16)
    return false;
  for (const f of PRIVATE_JWK_FIELDS) {
    if (f in j && j[f] != null) return false;
  }
  if (j.alg != null && j.alg !== "RSA-OAEP-256" && j.alg !== "RSA-OAEP") {
    return false;
  }
  if (j.use != null && j.use !== "enc") return false;
  if (j.key_ops != null) {
    if (!Array.isArray(j.key_ops) || j.key_ops.length === 0) return false;
    for (const op of j.key_ops) {
      if (op !== "encrypt") return false;
    }
  }
  return true;
}

export function isEncryptedLink(v: unknown): v is EncryptedLink {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    o.algorithm === "RSA-OAEP-256" &&
    typeof o.ciphertext === "string" &&
    /^[A-Za-z0-9_-]+$/.test(o.ciphertext) &&
    o.ciphertext.length >= 342 &&
    o.ciphertext.length <= 2048
  );
}

export function isJsonContentType(request: Request): boolean {
  const ct = request.headers.get("content-type");
  if (!ct) return false;
  return ct.toLowerCase().includes("application/json");
}
export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: "Invalid JSON body" | "Request body too large" };
export async function readJsonBody(
  request: Request,
  maxBytes = 16_384,
): Promise<JsonBodyResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, error: "Request body too large" };
  }
  if (!request.body) return { ok: false, error: "Invalid JSON body" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, error: "Request body too large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: JSON.parse(UTF8_DECODER.decode(bytes)) as unknown,
    };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  } finally {
    reader.releaseLock();
  }
}

export function parseSessionOrigin(v: unknown): SessionOrigin | null {
  if (v === undefined) return "workspace";
  return v === "workspace" || v === "adhoc" ? v : null;
}

export function parseSessionGroup(v: unknown): SessionGroup | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== "repository" && o.kind !== "folder") return null;
  if (!isNonEmptyString(o.name, 512)) return null;
  if (!isNonEmptyString(o.path, 1024)) return null;
  return { kind: o.kind, name: o.name, path: o.path };
}

export function parseSessionWorktree(v: unknown): SessionWorktree | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.name, 512)) return null;
  if (!isNonEmptyString(o.path, 1024)) return null;
  if (o.branch != null && !isNonEmptyString(o.branch, 256)) return null;
  return {
    name: o.name,
    path: o.path,
    ...(typeof o.branch === "string" ? { branch: o.branch } : {}),
  };
}

export function parseSessionSummary(v: unknown): SessionSummary | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isValidId(o.id)) return null;
  if (!isNonEmptyString(o.title, 256)) return null;
  if (!isNonEmptyString(o.cwd, 1024)) return null;
  if (!isIsoTimestamp(o.startedAt)) return null;
  if (!isIsoTimestamp(o.lastSeenAt)) return null;
  const origin = parseSessionOrigin(o.origin);
  if (!origin) return null;
  const group = parseSessionGroup(o.group);
  if (!group) return null;
  const worktree = parseSessionWorktree(o.worktree);
  if (!worktree) return null;
  return {
    id: o.id,
    title: o.title,
    cwd: o.cwd,
    startedAt: o.startedAt,
    lastSeenAt: o.lastSeenAt,
    origin,
    group,
    worktree,
  };
}

export function parseRecentSessionSummary(
  v: unknown,
): RecentSessionSummary | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isValidId(o.id)) return null;
  if (!isNonEmptyString(o.title, 256)) return null;
  if (!isIsoTimestamp(o.lastSeenAt)) return null;
  const origin = parseSessionOrigin(o.origin);
  if (!origin) return null;
  const group = parseSessionGroup(o.group);
  if (!group) return null;
  const worktree = parseSessionWorktree(o.worktree);
  if (!worktree) return null;
  return {
    id: o.id,
    title: o.title,
    lastSeenAt: o.lastSeenAt,
    origin,
    group,
    worktree,
  };
}

export function parseJoinRequest(v: unknown): JoinRequest | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isValidId(o.id)) return null;
  if (!isValidId(o.sessionId)) return null;
  if (!isNonEmptyString(o.deviceName, 128)) return null;
  if (!isValidPublicKeyJwk(o.publicKeyJwk)) return null;
  if (!isIsoTimestamp(o.createdAt)) return null;
  if (!isJoinRequestStatus(o.status)) return null;
  return {
    id: o.id,
    sessionId: o.sessionId,
    deviceName: o.deviceName,
    publicKeyJwk: o.publicKeyJwk,
    createdAt: o.createdAt,
    status: o.status,
  };
}

export function parseJoinRequestResult(v: unknown): JoinRequestResult | null {
  const base = parseJoinRequest(v);
  if (!base) return null;
  const o = v as Record<string, unknown>;
  if (o.encryptedLink == null) return base;
  if (!isEncryptedLink(o.encryptedLink)) return null;
  return { ...base, encryptedLink: o.encryptedLink };
}

/** Host heartbeat body — lastSeenAt derived server-side. Optional pid/sessionFile are host-only. */
export type HostSessionHeartbeatInput = {
  id: string;
  title: string;
  cwd: string;
  startedAt: string;
  origin?: SessionOrigin;
  pid?: number;
  /** Absolute host path to the session jsonl; never sent to browsers. */
  sessionFile?: string;
};

/** Host-only path: absolute, bounded, no control chars, must end with .jsonl. */
function isValidSessionFilePath(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > 1024) return false;
  if (v.includes("\0") || v.includes("\n")) return false;
  if (!v.startsWith("/")) return false;
  return v.endsWith(".jsonl");
}

export function parseHostSessionHeartbeat(
  v: unknown,
): HostSessionHeartbeatInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isValidId(o.id)) return null;
  if (!isNonEmptyString(o.title, 256)) return null;
  if (!isNonEmptyString(o.cwd, 1024)) return null;
  if (!isIsoTimestamp(o.startedAt)) return null;
  const rawPid = o.pid;
  const pid =
    typeof rawPid === "number" &&
    Number.isInteger(rawPid) &&
    rawPid >= 2 &&
    rawPid <= 0x7fffffff
      ? rawPid
      : undefined;
  let sessionFile: string | undefined;
  if (o.sessionFile !== undefined) {
    if (!isValidSessionFilePath(o.sessionFile)) return null;
    sessionFile = o.sessionFile;
  }
  const origin = parseSessionOrigin(o.origin);
  if (!origin) return null;
  return {
    id: o.id,
    title: o.title,
    cwd: o.cwd,
    startedAt: o.startedAt,
    origin,
    ...(pid !== undefined ? { pid } : {}),
    ...(sessionFile !== undefined ? { sessionFile } : {}),
  };
}

/** Browser request to start a blank local OMP session in a live worktree. */
export type LaunchSessionInput = { worktreePath: string };

export function parseLaunchSessionInput(v: unknown): LaunchSessionInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const record = v as Record<string, unknown>;
  if (Object.hasOwn(record, "prompt")) return null;
  return isNonEmptyString(record.worktreePath, 1024)
    ? { worktreePath: record.worktreePath }
    : null;
}

/** Browser request to create a linked Git worktree for a live repo group. */
export type CreateWorktreeInput = { groupPath: string };

export function parseCreateWorktreeInput(
  v: unknown,
): CreateWorktreeInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { groupPath } = v as Record<string, unknown>;
  return isNonEmptyString(groupPath, 1024) ? { groupPath } : null;
}

/** Browser request to favorite or unfavorite an advertised repository group. */
export type SetRepositoryFavoriteInput = {
  groupPath: string;
  favorite: boolean;
};

export function parseSetRepositoryFavoriteInput(
  v: unknown,
): SetRepositoryFavoriteInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { groupPath, favorite } = v as Record<string, unknown>;
  if (!isNonEmptyString(groupPath, 1024)) return null;
  if (typeof favorite !== "boolean") return null;
  return { groupPath, favorite };
}

/** Browser request to remove a linked Git worktree from a live repo group. */
export type DeleteWorktreeInput = {
  groupPath: string;
  worktreePath: string;
};

export function parseDeleteWorktreeInput(
  v: unknown,
): DeleteWorktreeInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { groupPath, worktreePath } = v as Record<string, unknown>;
  if (!isNonEmptyString(groupPath, 1024)) return null;
  if (!isNonEmptyString(worktreePath, 1024)) return null;
  return { groupPath, worktreePath };
}

export type PullRequestReadiness =
  | "ready"
  | "merged"
  | "draft"
  | "checks_failed"
  | "checks_pending"
  | "changes_requested"
  | "review_required"
  | "conflicts"
  | "unknown";

export type PullRequestAction =
  "fix_checks" | "resolve_comments" | "fix_conflicts" | "address_review";

export type WorktreePullRequestStatus = {
  worktreePath: string;
  branch: string;
  fetchedAt: string;
  pullRequest: null | {
    number: number;
    title: string;
    url: string;
    baseBranch: string;
    headBranch: string;
    isDraft: boolean;
    readiness: PullRequestReadiness;
    mergeable: "mergeable" | "conflicting" | "unknown";
    reviewDecision:
      "approved" | "changes_requested" | "review_required" | "none";
    checks: {
      state: "success" | "failure" | "pending" | "none";
      total: number;
      failed: number;
      pending: number;
    };
    unresolvedThreads: number;
  };
};

export type MergePullRequestInput = {
  worktreePath: string;
};

export function parseMergePullRequestInput(
  v: unknown,
): MergePullRequestInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { worktreePath } = v as Record<string, unknown>;
  return isNonEmptyString(worktreePath, 1024) ? { worktreePath } : null;
}

/** Browser request to launch an OMP PR repair session in a live worktree. */
export type LaunchPullRequestTaskInput = {
  worktreePath: string;
  action: PullRequestAction;
};

const PULL_REQUEST_ACTIONS: Record<PullRequestAction, true> = {
  fix_checks: true,
  resolve_comments: true,
  fix_conflicts: true,
  address_review: true,
};

export function parseLaunchPullRequestTaskInput(
  v: unknown,
): LaunchPullRequestTaskInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { worktreePath, action } = v as Record<string, unknown>;
  if (!isNonEmptyString(worktreePath, 1024)) return null;
  if (typeof action !== "string" || !(action in PULL_REQUEST_ACTIONS)) {
    return null;
  }
  return { worktreePath, action: action as PullRequestAction };
}

/** Browser create-request body. */
export type CreateJoinRequestInput = {
  deviceName: string;
  publicKeyJwk: JsonWebKey;
};

export function parseCreateJoinRequestInput(
  v: unknown,
): CreateJoinRequestInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.deviceName, 128)) return null;
  if (!isValidPublicKeyJwk(o.publicKeyJwk)) return null;
  return { deviceName: o.deviceName, publicKeyJwk: o.publicKeyJwk };
}

/** Host decision body (route path may also carry request id). */
export type RequestDecisionInput =
  | { sessionId: string; status: "denied" }
  | { sessionId: string; status: "approved"; encryptedLink: EncryptedLink };

export type DecideRequestInput = RequestDecisionInput & { requestId: string };

export function parseRequestDecision(v: unknown): RequestDecisionInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isValidId(o.sessionId)) return null;
  if (o.status === "denied") {
    if (o.encryptedLink != null) return null;
    return { sessionId: o.sessionId, status: "denied" };
  }
  if (o.status === "approved") {
    if (!isEncryptedLink(o.encryptedLink)) return null;
    return {
      sessionId: o.sessionId,
      status: "approved",
      encryptedLink: o.encryptedLink,
    };
  }
  return null;
}

export function stripEncryptedLink(r: JoinRequestResult): JoinRequest {
  return {
    id: r.id,
    sessionId: r.sessionId,
    deviceName: r.deviceName,
    publicKeyJwk: r.publicKeyJwk,
    createdAt: r.createdAt,
    status: r.status,
  };
}

export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data } satisfies ApiOk<T>, init);
}

export function jsonError(error: string, status = 400): Response {
  return Response.json({ error } satisfies ApiErr, { status });
}
