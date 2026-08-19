/** In-memory session + join-request store with SQLite location/resume durability. */

import {
  type CreateJoinRequestInput,
  type DashboardLocation,
  type EncryptedLink,
  type HostSessionHeartbeatInput,
  type JoinRequest,
  type JoinRequestResult,
  type RecentSessionSummary,
  type RequestDecisionInput,
  type SessionDashboard,
  type SessionSummary,
  REQUEST_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  isValidId,
  newId,
  stripEncryptedLink,
} from "../lib/contracts";
import {
  type DashboardDatabase,
  type ResumeSessionRow,
  DASHBOARD_DB_USER_VERSION,
  checkpointDashboardDb,
  closeDashboardDb,
  deleteDashboardLocation,
  deleteResumeSessionByResumeId,
  getResumeSessionByResumeId,
  importLegacyDashboardLocations,
  listDashboardLocations as listDashboardLocationsFromDb,
  listFavoriteRepositoryPaths as listFavoriteRepositoryPathsFromDb,
  listResumeSessionCandidates,
  openDashboardDb,
  setFavoriteRepository as setFavoriteRepositoryInDb,
  touchResumeSessionLastSeen,
  upsertDashboardLocation,
  upsertResumeSession,
} from "./dashboard-db";
import {
  clearLocationCache,
  readGitBranch,
  resolveSessionLocation,
} from "./location";

type Timed<T> = { value: T; expiresAt: number };

const sessions = new Map<string, Timed<SessionSummary>>();
/** Worktrees remain available after their last live session expires. */
const dashboardLocations = new Map<string, DashboardLocation>();
/** Repository group paths marked favorite (absolute SessionGroup.path). */
const favoriteRepositoryPaths = new Set<string>();
const inactiveSessionIds = new Set<string>();
const requests = new Map<string, Timed<JoinRequestResult>>();
/** sessionId → request ids */
const sessionRequestIndex = new Map<string, Set<string>>();
/** Host-only omp pids. Never copied onto SessionSummary. */
const sessionPids = new Map<string, number>();

/** Open dashboard DB handle for this process (locations + resumes). */
let dashboardDb: DashboardDatabase | undefined;
/**
 * Last fully-upserted resume identity fingerprint per sessionId (excludes lastSeenAt).
 * Pure lastSeen heartbeats only dirty-batch; identity changes upsert immediately.
 */
const resumeIdentities = new Map<string, string>();
/** sessionId → latest lastSeenAt awaiting batched DB touch. */
const dirtyLastSeen = new Map<string, string>();

const LOGIN_ATTEMPT_WINDOW_MS = 60_000;
export const LOGIN_ATTEMPT_WINDOW_SECONDS = 60;
export const LOGIN_ATTEMPT_MAX = 10;

/** Display cap for public recentSessions (DB may hold more). */
export const RECENT_SESSIONS_DISPLAY_LIMIT = 50 as const;
/** Default dirty lastSeen flush interval. */
export const RESUME_LAST_SEEN_FLUSH_MS = 30_000 as const;

type LoginWindow = { count: number; resetAt: number };
let loginWindow: LoginWindow | undefined;

export type SessionChangeListener = (sessions: SessionSummary[]) => void;
const sessionListeners = new Set<SessionChangeListener>();
const PRUNE_INTERVAL_MS = 2_000;
let pruneTimer: ReturnType<typeof setInterval> | undefined;
let lastSeenFlushTimer: ReturnType<typeof setTimeout> | undefined;
let lastSeenFlushMs: number = RESUME_LAST_SEEN_FLUSH_MS;

/** Test seam — override wall clock for deterministic TTL pruning. */
let nowMs: () => number = () => Date.now();

export function setNowForTests(fn: (() => number) | null): void {
  nowMs = fn ?? (() => Date.now());
}

/** Test seam — override dirty lastSeen flush interval (null restores default). */
export function setResumeLastSeenFlushMsForTests(ms: number | null): void {
  lastSeenFlushMs = ms === null ? RESUME_LAST_SEEN_FLUSH_MS : ms;
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
    s.origin,
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

function resumeIdentityFingerprint(
  session: SessionSummary,
  sessionFile: string,
): string {
  return [
    sessionFile,
    session.title,
    session.origin,
    session.group.kind,
    session.group.name,
    session.group.path,
    session.worktree.name,
    session.worktree.path,
    session.worktree.branch ?? "",
  ].join("\0");
}

function loadLocationIntoMemory(location: DashboardLocation): void {
  dashboardLocations.set(
    dashboardLocationKey(location.group.path, location.worktree.path),
    location,
  );
}

function writeDashboardLocation(location: DashboardLocation): boolean {
  const key = dashboardLocationKey(location.group.path, location.worktree.path);
  const previous = dashboardLocations.get(key);
  const lastSessionStartedAt =
    previous &&
    Date.parse(previous.lastSessionStartedAt) >
      Date.parse(location.lastSessionStartedAt)
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
  if (changed && dashboardDb) {
    try {
      upsertDashboardLocation(dashboardDb, next);
    } catch {
      // Sharing remains usable if location history cannot be persisted.
    }
  }
  return changed;
}

function clearLastSeenFlushTimer(): void {
  if (lastSeenFlushTimer === undefined) return;
  clearTimeout(lastSeenFlushTimer);
  lastSeenFlushTimer = undefined;
}

function ensureLastSeenFlushTimer(): void {
  if (lastSeenFlushTimer !== undefined || dirtyLastSeen.size === 0) return;
  lastSeenFlushTimer = setTimeout(() => {
    lastSeenFlushTimer = undefined;
    flushDirtyLastSeen();
  }, lastSeenFlushMs);
  if (
    typeof lastSeenFlushTimer === "object" &&
    lastSeenFlushTimer &&
    "unref" in lastSeenFlushTimer
  ) {
    lastSeenFlushTimer.unref();
  }
}

/** Write pending resume lastSeenAt touches. Returns number of session ids flushed. */
export function flushDirtyLastSeen(): number {
  const handle = dashboardDb;
  if (!handle || dirtyLastSeen.size === 0) {
    dirtyLastSeen.clear();
    clearLastSeenFlushTimer();
    return 0;
  }
  const pending = [...dirtyLastSeen.entries()];
  dirtyLastSeen.clear();
  clearLastSeenFlushTimer();
  let flushed = 0;
  for (const [sessionId, lastSeenAt] of pending) {
    try {
      if (touchResumeSessionLastSeen(handle, sessionId, lastSeenAt))
        flushed += 1;
    } catch {
      // Best-effort; re-dirty so a later flush/shutdown can retry.
      if (!dirtyLastSeen.has(sessionId))
        dirtyLastSeen.set(sessionId, lastSeenAt);
    }
  }
  if (dirtyLastSeen.size > 0) ensureLastSeenFlushTimer();
  return flushed;
}

/** Flush dirty lastSeen rows and best-effort WAL checkpoint. */
export function flushDashboardDb(): void {
  flushDirtyLastSeen();
  if (dashboardDb) checkpointDashboardDb(dashboardDb, "PASSIVE");
}

/**
 * Open (or replace) the process dashboard DB.
 * Optionally one-time imports legacy locations JSON (byte-preserving source).
 * Loads remembered locations into the in-memory registry.
 */
export function configureDashboardDb(
  dbPath: string,
  legacyLocationsPath?: string,
): void {
  closeDashboardPersistence();
  const handle = openDashboardDb(dbPath);
  if (legacyLocationsPath) {
    try {
      importLegacyDashboardLocations(handle, legacyLocationsPath);
    } catch {
      // Missing/invalid legacy file is fine; DB stays empty of imported rows.
    }
  }
  dashboardDb = handle;
  dashboardLocations.clear();
  favoriteRepositoryPaths.clear();
  try {
    for (const location of listDashboardLocationsFromDb(handle)) {
      loadLocationIntoMemory(location);
    }
  } catch {
    // Start with empty in-memory locations if the read fails.
  }
  try {
    for (const groupPath of listFavoriteRepositoryPathsFromDb(handle)) {
      favoriteRepositoryPaths.add(groupPath);
    }
  } catch {
    // Start with empty favorites if the read fails.
  }
}

/**
 * Backward-compatible alias: treat the path as a SQLite DB path when it ends
 * with `.sqlite`; otherwise open `<path>.sqlite` beside the legacy JSON and
 * import that JSON once via DB bootstrap.
 */
export function configureDashboardLocationPersistence(path: string): void {
  if (path.endsWith(".sqlite")) {
    configureDashboardDb(path);
    return;
  }
  configureDashboardDb(`${path}.sqlite`, path);
}

/**
 * Process-local DB readiness: open handle, expected user_version, SELECT 1.
 * No writes, no quick_check, no row counts, no paths/errors in the result.
 */
export function probeDashboardDbHealth(): "healthy" | "unavailable" {
  const handle = dashboardDb;
  if (!handle) return "unavailable";
  try {
    const row = handle.db.query("PRAGMA user_version").get() as
      { user_version: number } | null | undefined;
    if (!row || row.user_version !== DASHBOARD_DB_USER_VERSION) {
      return "unavailable";
    }
    handle.db.query("SELECT 1").get();
    return "healthy";
  } catch {
    return "unavailable";
  }
}

/** Flush, checkpoint, and close the dashboard DB. Safe to call when unset. */
export function closeDashboardPersistence(): void {
  const handle = dashboardDb;
  if (!handle) {
    dirtyLastSeen.clear();
    resumeIdentities.clear();
    clearLastSeenFlushTimer();
    return;
  }
  try {
    flushDirtyLastSeen();
  } catch {
    // still close
  }
  dashboardDb = undefined;
  dirtyLastSeen.clear();
  resumeIdentities.clear();
  clearLastSeenFlushTimer();
  try {
    closeDashboardDb(handle);
  } catch {
    // Double-close / already-closed is a no-op at the DB layer.
  }
}

function persistResumeFromHeartbeat(
  input: HostSessionHeartbeatInput,
  session: SessionSummary,
): void {
  const handle = dashboardDb;
  const sessionFile = input.sessionFile;
  if (!handle || !sessionFile) return;

  const identity = resumeIdentityFingerprint(session, sessionFile);
  const previous = resumeIdentities.get(session.id);
  if (previous !== identity) {
    try {
      upsertResumeSession(handle, {
        sessionId: session.id,
        sessionFile,
        title: session.title,
        startedAt: session.startedAt,
        origin: session.origin,
        lastSeenAt: session.lastSeenAt,
        group: session.group,
        worktree: session.worktree,
      });
      resumeIdentities.set(session.id, identity);
      dirtyLastSeen.delete(session.id);
    } catch {
      // Sharing remains usable if resume identity cannot be persisted.
    }
    return;
  }

  dirtyLastSeen.set(session.id, session.lastSeenAt);
  ensureLastSeenFlushTimer();
}

function flushDirtyLastSeenFor(sessionId: string): void {
  const handle = dashboardDb;
  const lastSeenAt = dirtyLastSeen.get(sessionId);
  if (!handle || lastSeenAt === undefined) return;
  dirtyLastSeen.delete(sessionId);
  try {
    touchResumeSessionLastSeen(handle, sessionId, lastSeenAt);
  } catch {
    dirtyLastSeen.set(sessionId, lastSeenAt);
  }
  if (dirtyLastSeen.size === 0) clearLastSeenFlushTimer();
}

/** Drop expired sessions; returns true when any removed. */
function pruneExpiredSessions(now = nowMs()): boolean {
  let changed = false;
  for (const [id, entry] of sessions) {
    if (!alive(entry, now)) {
      flushDirtyLastSeenFor(id);
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
 * SSE callers should re-read getSessionDashboard() on notify (includes recents).
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
      flushDirtyLastSeenFor(id);
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
    origin: input.origin ?? "workspace",
    group: location.group,
    worktree,
  };
  const changed = meaningfulChanged(existing, session);
  const locationChanged =
    session.origin === "adhoc"
      ? false
      : writeDashboardLocation({
          group: session.group,
          worktree: session.worktree,
          lastSessionStartedAt: session.startedAt,
        });
  writeSession(session, now);
  if (input.pid !== undefined) sessionPids.set(session.id, input.pid);
  // Host-only resume identity — never copied onto SessionSummary / listener payload.
  persistResumeFromHeartbeat(input, session);
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

/** Register a discovery batch with one durable write path and one listener update. */
export function registerDashboardLocations(
  locations: DashboardLocation[],
): number {
  let changed = 0;
  for (const location of locations) {
    if (writeDashboardLocation(location)) changed++;
  }
  if (changed > 0) notifySessionListeners();
  return changed;
}

export function listDashboardLocations(): DashboardLocation[] {
  return [...dashboardLocations.values()].sort(
    (a, b) =>
      Date.parse(b.lastSessionStartedAt) - Date.parse(a.lastSessionStartedAt),
  );
}

/**
 * Public recent candidates newest-first, capped for display.
 * Excludes rows whose sessionId is currently live. Never includes sessionFile.
 */
export function listRecentSessions(
  excludeSessionIds?: Iterable<string>,
): RecentSessionSummary[] {
  const handle = dashboardDb;
  if (!handle) return [];
  const exclude =
    excludeSessionIds === undefined ? liveSessionIds() : excludeSessionIds;
  try {
    const candidates = listResumeSessionCandidates(handle, exclude);
    if (candidates.length <= RECENT_SESSIONS_DISPLAY_LIMIT) return candidates;
    return candidates.slice(0, RECENT_SESSIONS_DISPLAY_LIMIT);
  } catch {
    return [];
  }
}

function liveSessionIds(now = nowMs()): string[] {
  pruneExpiredSessions(now);
  return [...sessions.keys()];
}

export function getSessionDashboard(): SessionDashboard {
  const live = listSessions();
  return {
    sessions: live,
    locations: listDashboardLocations(),
    recentSessions: listRecentSessions(live.map((s) => s.id)),
    favoriteRepositoryPaths: listFavoriteRepositoryPaths(),
  };
}

/** Absolute repository group paths currently marked favorite. */
export function listFavoriteRepositoryPaths(): string[] {
  return [...favoriteRepositoryPaths].sort();
}

/**
 * Persist a repository favorite flag and notify dashboard subscribers.
 * Callers must validate that groupPath is an advertised repository group.
 */
export function setRepositoryFavorite(
  groupPath: string,
  favorite: boolean,
): void {
  const had = favoriteRepositoryPaths.has(groupPath);
  if (favorite) {
    if (!had) favoriteRepositoryPaths.add(groupPath);
  } else if (had) {
    favoriteRepositoryPaths.delete(groupPath);
  }
  if (dashboardDb) {
    try {
      setFavoriteRepositoryInDb(dashboardDb, groupPath, favorite);
    } catch {
      // Revert memory if durable write fails so snapshot stays consistent.
      if (favorite) {
        if (!had) favoriteRepositoryPaths.delete(groupPath);
      } else if (had) {
        favoriteRepositoryPaths.add(groupPath);
      }
      throw new Error("could not persist repository favorite");
    }
  }
  if (had !== favorite) notifySessionListeners();
}

/**
 * Host-only resume row by opaque resumeId (includes sessionFile).
 * Never expose this object on browser/SSE payloads.
 */
export function getResumeSession(resumeId: string): ResumeSessionRow | null {
  const handle = dashboardDb;
  if (!handle || !isValidId(resumeId)) return null;
  try {
    return getResumeSessionByResumeId(handle, resumeId);
  } catch {
    return null;
  }
}

/** Delete a remembered resume row by opaque resumeId. */
export function deleteResumeSession(resumeId: string): boolean {
  const handle = dashboardDb;
  if (!handle || !isValidId(resumeId)) return false;
  try {
    const removed = deleteResumeSessionByResumeId(handle, resumeId);
    if (removed) notifySessionListeners();
    return removed;
  } catch {
    return false;
  }
}

export function removeDashboardLocation(
  groupPath: string,
  worktreePath: string,
): boolean {
  const removedMemory = dashboardLocations.delete(
    dashboardLocationKey(groupPath, worktreePath),
  );
  let removedDb = false;
  if (dashboardDb) {
    try {
      removedDb = deleteDashboardLocation(dashboardDb, groupPath, worktreePath);
    } catch {
      removedDb = false;
    }
  }
  const removed = removedMemory || removedDb;
  if (removed) notifySessionListeners();
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
  flushDirtyLastSeenFor(id);
  sessions.delete(id);
  sessionPids.delete(id);
  inactiveSessionIds.add(id);
  // Resume row is retained — deactivation reveals Recent via getSessionDashboard.
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

/** Allow a deliberately resumed session id to become live again. */
export function reactivateSession(id: string): void {
  if (isValidId(id)) inactiveSessionIds.delete(id);
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

/** Test helper — wipe all maps, close DB, and restore clock/timers. */
export function resetStoreForTests(): void {
  closeDashboardPersistence();
  sessions.clear();
  dashboardLocations.clear();
  favoriteRepositoryPaths.clear();
  inactiveSessionIds.clear();
  requests.clear();
  sessionRequestIndex.clear();
  sessionPids.clear();
  loginWindow = undefined;
  nowMs = () => Date.now();
  lastSeenFlushMs = RESUME_LAST_SEEN_FLUSH_MS;
  clearLocationCache();
  sessionListeners.clear();
  if (pruneTimer !== undefined) {
    clearInterval(pruneTimer);
    pruneTimer = undefined;
  }
}
