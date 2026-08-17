/** In-memory session + join-request store with TTL Maps. */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type CreateJoinRequestInput,
  type DashboardLocation,
  type EncryptedLink,
  type HostSessionHeartbeatInput,
  type JoinRequest,
  type JoinRequestResult,
  type RequestDecisionInput,
  type SessionDashboard,
  type SessionSummary,
  REQUEST_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  isIsoTimestamp,
  isValidId,
  newId,
  parseSessionGroup,
  parseSessionWorktree,
  stripEncryptedLink,
} from "../lib/contracts";
import { clearLocationCache, readGitBranch, resolveSessionLocation } from "./location";

type Timed<T> = { value: T; expiresAt: number };

const sessions = new Map<string, Timed<SessionSummary>>();
/** Worktrees remain available after their last live session expires. */
const dashboardLocations = new Map<string, DashboardLocation>();
let dashboardLocationsPersistencePath: string | undefined;
const inactiveSessionIds = new Set<string>();
const requests = new Map<string, Timed<JoinRequestResult>>();
/** sessionId → request ids */
const sessionRequestIndex = new Map<string, Set<string>>();
/** Host-only omp pids. Never copied onto SessionSummary. */
const sessionPids = new Map<string, number>();

const LOGIN_ATTEMPT_WINDOW_MS = 60_000;
export const LOGIN_ATTEMPT_WINDOW_SECONDS = 60;
export const LOGIN_ATTEMPT_MAX = 10;

type LoginWindow = { count: number; resetAt: number };
let loginWindow: LoginWindow | undefined;

export type SessionChangeListener = (sessions: SessionSummary[]) => void;
const sessionListeners = new Set<SessionChangeListener>();
const PRUNE_INTERVAL_MS = 2_000;
let pruneTimer: ReturnType<typeof setInterval> | undefined;

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

function sessionFingerprint(s: SessionSummary): string {
  // Meaningful fields only — lastSeenAt heartbeats do not notify.
  return [
    s.id,
    s.title,
    s.cwd,
    s.startedAt,
    s.group.kind,
    s.group.name,
    s.group.path,
    s.worktree.name,
    s.worktree.path,
    s.worktree.branch ?? "",
  ].join("\0");
}

function meaningfulChanged(
  prev: SessionSummary | null,
  next: SessionSummary,
): boolean {
  if (!prev) return true;
  return sessionFingerprint(prev) !== sessionFingerprint(next);
}

function dashboardLocationKey(groupPath: string, worktreePath: string): string {
  return `${groupPath}\0${worktreePath}`;
}

function writeDashboardLocation(location: DashboardLocation): boolean {
  const key = dashboardLocationKey(location.group.path, location.worktree.path);
  const previous = dashboardLocations.get(key);
  const lastSessionStartedAt =
    previous && Date.parse(previous.lastSessionStartedAt) > Date.parse(location.lastSessionStartedAt)
      ? previous.lastSessionStartedAt
      : location.lastSessionStartedAt;
  const next = { ...location, lastSessionStartedAt };
  const changed =
    !previous ||
    previous.group.kind !== next.group.kind ||
    previous.group.name !== next.group.name ||
    previous.worktree.name !== next.worktree.name ||
    previous.worktree.branch !== next.worktree.branch ||
    previous.lastSessionStartedAt !== next.lastSessionStartedAt;
  dashboardLocations.set(key, next);
  return changed;
}

function parseDashboardLocation(value: unknown): DashboardLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const group = parseSessionGroup(record.group);
  const worktree = parseSessionWorktree(record.worktree);
  if (!group || !worktree || !isIsoTimestamp(record.lastSessionStartedAt)) return null;
  return { group, worktree, lastSessionStartedAt: record.lastSessionStartedAt };
}

function persistDashboardLocations(): void {
  const path = dashboardLocationsPersistencePath;
  if (!path) return;
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, locations: listDashboardLocations() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch {
    // Sharing remains usable if location history cannot be persisted.
  }
}

/** Load and enable durable location history for this daemon process. */
export function configureDashboardLocationPersistence(path: string): void {
  dashboardLocationsPersistencePath = path;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as { version?: unknown; locations?: unknown };
    if (record.version !== 1 || !Array.isArray(record.locations)) return;
    for (const value of record.locations) {
      const location = parseDashboardLocation(value);
      if (location) writeDashboardLocation(location);
    }
  } catch {
    // Missing or invalid history starts with an empty registry.
  }
}

/** Drop expired sessions; returns true when any removed. */
function pruneExpiredSessions(now = nowMs()): boolean {
  let changed = false;
  for (const [id, entry] of sessions) {
    if (!alive(entry, now)) {
      sessions.delete(id);
      sessionPids.delete(id);
      changed = true;
    }
  }
  return changed;
}

function sortedLiveSessions(now = nowMs()): SessionSummary[] {
  pruneExpiredSessions(now);
  const out: SessionSummary[] = [];
  for (const entry of sessions.values()) out.push(entry.value);
  out.sort((a, b) =>
    a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0,
  );
  return out;
}

function notifySessionListeners(): void {
  if (sessionListeners.size === 0) return;
  const snapshot = sortedLiveSessions();
  for (const listener of sessionListeners) {
    try {
      listener(snapshot);
    } catch {
      // listener errors must not break the store
    }
  }
}

function ensurePruneTimer(): void {
  if (pruneTimer !== undefined) return;
  pruneTimer = setInterval(() => {
    if (pruneExpiredSessions()) notifySessionListeners();
  }, PRUNE_INTERVAL_MS);
  if (typeof pruneTimer === "object" && pruneTimer && "unref" in pruneTimer) {
    pruneTimer.unref();
  }
}

function stopPruneTimerIfIdle(): void {
  if (sessionListeners.size > 0 || pruneTimer === undefined) return;
  clearInterval(pruneTimer);
  pruneTimer = undefined;
}

/**
 * Subscribe to meaningful session list changes (create, title/cwd/group,
 * expiry). Returns unsubscribe. Starts a prune timer while any listener is live.
 */
export function subscribeSessionChanges(
  listener: SessionChangeListener,
): () => void {
  sessionListeners.add(listener);
  ensurePruneTimer();
  return () => {
    sessionListeners.delete(listener);
    stopPruneTimerIfIdle();
  };
}

function readSession(id: string, now = nowMs()): SessionSummary | null {
  if (!isValidId(id)) return null;
  const entry = sessions.get(id);
  if (!alive(entry, now)) {
    if (entry) {
      sessions.delete(id);
      sessionPids.delete(id);
      // Expiry noticed on read — notify only when someone is listening.
      if (sessionListeners.size > 0) notifySessionListeners();
    }
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
  const location =
    existing && existing.cwd === input.cwd
      ? { group: existing.group, worktree: existing.worktree }
      : resolveSessionLocation(input.cwd);
  const branch = readGitBranch(location.worktree.path, now);
  const worktree = branch
    ? { name: location.worktree.name, path: location.worktree.path, branch }
    : { name: location.worktree.name, path: location.worktree.path };
  const session: SessionSummary = {
    id: input.id,
    title: input.title,
    cwd: input.cwd,
    startedAt: existing?.startedAt ?? input.startedAt,
    lastSeenAt: new Date(now).toISOString(),
    group: location.group,
    worktree,
  };
  const changed = meaningfulChanged(existing, session);
  const locationChanged = writeDashboardLocation({
    group: session.group,
    worktree: session.worktree,
    lastSessionStartedAt: session.startedAt,
  });
  if (locationChanged) persistDashboardLocations();
  writeSession(session, now);
  if (input.pid !== undefined) sessionPids.set(session.id, input.pid);
  if (changed || locationChanged) notifySessionListeners();
  return session;
}

function dashboardLocationForPath(
  cwd: string,
  lastSessionStartedAt: string,
): DashboardLocation {
  const location = resolveSessionLocation(cwd);
  const branch = readGitBranch(location.worktree.path, nowMs());
  return {
    group: location.group,
    worktree: branch ? { ...location.worktree, branch } : location.worktree,
    lastSessionStartedAt,
  };
}

/** Remember paths so they remain actionable before or after any live session. */
export function registerDashboardPaths(
  cwds: string[],
  lastSessionStartedAt = new Date(nowMs()).toISOString(),
): DashboardLocation[] {
  const locations = cwds.map((cwd) =>
    dashboardLocationForPath(cwd, lastSessionStartedAt),
  );
  registerDashboardLocations(locations);
  return locations;
}

/** Remember one path so it remains actionable before or after any live session. */
export function registerDashboardLocation(
  cwd: string,
  lastSessionStartedAt = new Date(nowMs()).toISOString(),
): DashboardLocation {
  return registerDashboardPaths([cwd], lastSessionStartedAt)[0]!;
}

/** Register a discovery batch with one durable write and one listener update. */
export function registerDashboardLocations(
  locations: DashboardLocation[],
): number {
  let changed = 0;
  for (const location of locations) {
    if (writeDashboardLocation(location)) changed++;
  }
  if (changed > 0) {
    persistDashboardLocations();
    notifySessionListeners();
  }
  return changed;
}

export function listDashboardLocations(): DashboardLocation[] {
  return [...dashboardLocations.values()].sort(
    (a, b) => Date.parse(b.lastSessionStartedAt) - Date.parse(a.lastSessionStartedAt),
  );
}

export function getSessionDashboard(): SessionDashboard {
  return { sessions: listSessions(), locations: listDashboardLocations() };
}

export function removeDashboardLocation(
  groupPath: string,
  worktreePath: string,
): boolean {
  const removed = dashboardLocations.delete(
    dashboardLocationKey(groupPath, worktreePath),
  );
  if (removed) {
    persistDashboardLocations();
    notifySessionListeners();
  }
  return removed;
}

export function getSession(id: string): SessionSummary | null {
  return readSession(id);
}

/** All live sessions, newest lastSeenAt first. */
export function listSessions(): SessionSummary[] {
  return sortedLiveSessions();
}

/** Hide a live session and suppress its future heartbeats until daemon restart. */
export function deactivateSession(id: string): boolean {
  if (!isValidId(id) || !readSession(id)) return false;
  sessions.delete(id);
  sessionPids.delete(id);
  inactiveSessionIds.add(id);
  notifySessionListeners();
  return true;
}

/** Pid to SIGTERM only if no other live session shares it. */
export function exclusiveSessionPid(id: string): number | undefined {
  const pid = sessionPids.get(id);
  if (pid === undefined || !readSession(id)) return undefined;
  for (const [otherId, otherPid] of sessionPids) {
    if (otherId !== id && otherPid === pid && readSession(otherId)) {
      return undefined;
    }
  }
  return pid;
}

export function isSessionInactive(id: string): boolean {
  return isValidId(id) && inactiveSessionIds.has(id);
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
  dashboardLocations.clear();
  dashboardLocationsPersistencePath = undefined;
  inactiveSessionIds.clear();
  requests.clear();
  sessionRequestIndex.clear();
  sessionPids.clear();
  loginWindow = undefined;
  nowMs = () => Date.now();
  clearLocationCache();
  sessionListeners.clear();
  if (pruneTimer !== undefined) {
    clearInterval(pruneTimer);
    pruneTimer = undefined;
  }
}
