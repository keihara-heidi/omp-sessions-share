/** Shared API contracts — never includes plaintext collab links. */

export type SessionGroupKind = "repository" | "folder";

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
  id: string;
  title: string;
  cwd: string;
  startedAt: string;
  lastSeenAt: string;
  group: SessionGroup;
  worktree: SessionWorktree;
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
  if (typeof j.n !== "string" || j.n.length < 342 || j.n.length > 1024) return false;
  if (typeof j.e !== "string" || j.e.length < 1 || j.e.length > 16) return false;
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
    return { ok: true, value: JSON.parse(UTF8_DECODER.decode(bytes)) as unknown };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  } finally {
    reader.releaseLock();
  }
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

/** Host heartbeat body — lastSeenAt derived server-side. */
export type HostSessionHeartbeatInput = {
  id: string;
  title: string;
  cwd: string;
  startedAt: string;
};

export function parseHostSessionHeartbeat(
  v: unknown,
): HostSessionHeartbeatInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isValidId(o.id)) return null;
  if (!isNonEmptyString(o.title, 256)) return null;
  if (!isNonEmptyString(o.cwd, 1024)) return null;
  if (!isIsoTimestamp(o.startedAt)) return null;
  return {
    id: o.id,
    title: o.title,
    cwd: o.cwd,
    startedAt: o.startedAt,
  };
}

/** Browser request to start a local OMP session in a live worktree. */
export type LaunchSessionInput = { worktreePath: string };

export function parseLaunchSessionInput(v: unknown): LaunchSessionInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { worktreePath } = v as Record<string, unknown>;
  return isNonEmptyString(worktreePath, 1024) ? { worktreePath } : null;
}

/** Browser request to create a blank managed worktree for a live repo group. */
export type CreateWorktreeInput = { groupPath: string };

export function parseCreateWorktreeInput(v: unknown): CreateWorktreeInput | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { groupPath } = v as Record<string, unknown>;
  return isNonEmptyString(groupPath, 1024) ? { groupPath } : null;
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

