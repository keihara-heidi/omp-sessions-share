/** In-memory session + join-request store with TTL Maps. */

import {
  type CreateJoinRequestInput,
  type EncryptedLink,
  type HostSessionHeartbeatInput,
  type JoinRequest,
  type JoinRequestResult,
  type RequestDecisionInput,
  type SessionSummary,
  REQUEST_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  isValidId,
  newId,
  stripEncryptedLink,
} from "../lib/contracts";

type Timed<T> = { value: T; expiresAt: number };

const sessions = new Map<string, Timed<SessionSummary>>();
const requests = new Map<string, Timed<JoinRequestResult>>();
/** sessionId → request ids */
const sessionRequestIndex = new Map<string, Set<string>>();

const LOGIN_ATTEMPT_WINDOW_MS = 60_000;
export const LOGIN_ATTEMPT_WINDOW_SECONDS = 60;
export const LOGIN_ATTEMPT_MAX = 10;

type LoginWindow = { count: number; resetAt: number };
let loginWindow: LoginWindow | undefined;

/** Test seam — override wall clock for deterministic TTL pruning. */
let nowMs: () => number = () => Date.now();

export function setNowForTests(fn: (() => number) | null): void {
  nowMs = fn ?? (() => Date.now());
}
function ttlMs(seconds: number): number {
  return seconds * 1000;
}

function alive<T>(entry: Timed<T> | undefined, now: number): boolean {
  return !!entry && entry.expiresAt > now;
}

function readSession(id: string, now = nowMs()): SessionSummary | null {
  if (!isValidId(id)) return null;
  const entry = sessions.get(id);
  if (!alive(entry, now)) {
    if (entry) sessions.delete(id);
    return null;
  }
  return entry!.value;
}

function readRequest(id: string, now = nowMs()): JoinRequestResult | null {
  if (!isValidId(id)) return null;
  const entry = requests.get(id);
  if (!alive(entry, now)) {
    if (entry) {
      requests.delete(id);
      const idx = sessionRequestIndex.get(entry.value.sessionId);
      idx?.delete(id);
    }
    return null;
  }
  return entry!.value;
}

function writeSession(session: SessionSummary, now = nowMs()): void {
  sessions.set(session.id, {
    value: session,
    expiresAt: now + ttlMs(SESSION_TTL_SECONDS),
  });
}

function writeRequest(req: JoinRequestResult, expiresAt: number): void {
  requests.set(req.id, { value: req, expiresAt });
  let idx = sessionRequestIndex.get(req.sessionId);
  if (!idx) {
    idx = new Set();
    sessionRequestIndex.set(req.sessionId, idx);
  }
  idx.add(req.id);
}

export function upsertSession(
  input: HostSessionHeartbeatInput,
): SessionSummary {
  if (!isValidId(input.id)) throw new Error("invalid session id");
  const now = nowMs();
  const existing = readSession(input.id, now);
  const session: SessionSummary = {
    id: input.id,
    title: input.title,
    cwd: input.cwd,
    startedAt: existing?.startedAt ?? input.startedAt,
    lastSeenAt: new Date(now).toISOString(),
  };
  writeSession(session, now);
  return session;
}

export function getSession(id: string): SessionSummary | null {
  return readSession(id);
}

/** All live sessions, newest lastSeenAt first. */
export function listSessions(): SessionSummary[] {
  const now = nowMs();
  const out: SessionSummary[] = [];
  for (const [id, entry] of sessions) {
    if (!alive(entry, now)) {
      sessions.delete(id);
      continue;
    }
    out.push(entry.value);
  }
  out.sort((a, b) =>
    a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0,
  );
  return out;
}

export type CreateRequestArgs = CreateJoinRequestInput & { sessionId: string };

export function createRequest(input: CreateRequestArgs): JoinRequest {
  const { sessionId } = input;
  if (!isValidId(sessionId)) throw new Error("invalid session id");
  const session = readSession(sessionId);
  if (!session) throw new Error("session not found");

  const now = nowMs();
  const req: JoinRequestResult = {
    id: newId(),
    sessionId,
    deviceName: input.deviceName,
    publicKeyJwk: input.publicKeyJwk,
    createdAt: new Date(now).toISOString(),
    status: "pending",
  };
  writeRequest(req, now + ttlMs(REQUEST_TTL_SECONDS));
  return stripEncryptedLink(req);
}

export function getRequest(id: string): JoinRequestResult | null {
  return readRequest(id);
}

/** Requests for a session; null if session missing. Omits encryptedLink. */
export function listRequestsBySession(sessionId: string): JoinRequest[] | null {
  if (!isValidId(sessionId)) return null;
  if (!readSession(sessionId)) return null;
  const now = nowMs();
  const idx = sessionRequestIndex.get(sessionId);
  if (!idx || idx.size === 0) return [];
  const out: JoinRequest[] = [];
  for (const id of [...idx]) {
    const req = readRequest(id, now);
    if (!req) {
      idx.delete(id);
      continue;
    }
    out.push(stripEncryptedLink(req));
  }
  out.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  return out;
}

export type DecideRequestArgs = RequestDecisionInput & { requestId: string };

export function decideRequest(
  decision: DecideRequestArgs,
): JoinRequestResult | null {
  const id = decision.requestId;
  if (!isValidId(id)) return null;
  const existingEntry = requests.get(id);
  const now = nowMs();
  if (!alive(existingEntry, now)) {
    if (existingEntry) requests.delete(id);
    return null;
  }
  const existing = existingEntry!.value;
  if (existing.sessionId !== decision.sessionId) {
    throw new Error("session mismatch");
  }
  if (existing.status !== "pending") {
    throw new Error("request already decided");
  }
  if (!readSession(existing.sessionId, now)) {
    throw new Error("session not found");
  }

  let next: JoinRequestResult;
  if (decision.status === "denied") {
    next = {
      id: existing.id,
      sessionId: existing.sessionId,
      deviceName: existing.deviceName,
      publicKeyJwk: existing.publicKeyJwk,
      createdAt: existing.createdAt,
      status: "denied",
    };
  } else {
    const link: EncryptedLink = decision.encryptedLink;
    next = {
      id: existing.id,
      sessionId: existing.sessionId,
      deviceName: existing.deviceName,
      publicKeyJwk: existing.publicKeyJwk,
      createdAt: existing.createdAt,
      status: "approved",
      encryptedLink: link,
    };
  }
  writeRequest(next, existingEntry!.expiresAt);
  return next;
}


/** Global fixed-window login limit for this single-user daemon. */
export function consumeLoginAttempt(): boolean {
  const now = nowMs();
  if (!loginWindow || loginWindow.resetAt <= now) {
    loginWindow = { count: 1, resetAt: now + LOGIN_ATTEMPT_WINDOW_MS };
    return true;
  }
  loginWindow.count += 1;
  return loginWindow.count <= LOGIN_ATTEMPT_MAX;
}

/** Test helper — wipe all maps and restore clock. */
export function resetStoreForTests(): void {
  sessions.clear();
  requests.clear();
  sessionRequestIndex.clear();
  loginWindow = undefined;
  nowMs = () => Date.now();
}
