/** Private dashboard SQLite — locations + session resumes (bun:sqlite). */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type DashboardLocation,
  type RecentSessionSummary,
  type SessionGroup,
  type SessionGroupKind,
  type SessionWorktree,
  isIsoTimestamp,
  isNonEmptyString,
  isValidId,
  newId,
  parseSessionGroup,
  parseSessionWorktree,
} from "../lib/contracts";
import { getDashboardDbPath } from "../shared/config";

/** Supported schema version written via PRAGMA user_version. */
export const DASHBOARD_DB_USER_VERSION = 1 as const;

/** Retention: drop resume rows older than this many days (unless live-protected). */
export const RESUME_SESSION_MAX_AGE_DAYS = 90 as const;

/** Retention: keep at most this many non-protected resume rows. */
export const RESUME_SESSION_MAX_ROWS = 1000 as const;

/** meta.key once legacy locations JSON has been considered. */
export const LEGACY_LOCATIONS_IMPORT_META_KEY = "legacy_locations_imported" as const;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Minimal handle for open/close/checkpoint + CRUD. */
export type DashboardDatabase = {
  readonly path: string;
  readonly db: Database;
};

/** Private host-only resume row — sessionFile never crosses the public API. */
export type ResumeSessionRow = {
  resumeId: string;
  sessionId: string;
  sessionFile: string;
  title: string;
  startedAt: string;
  lastSeenAt: string;
  group: SessionGroup;
  worktree: SessionWorktree;
};

/** Upsert payload keyed by sessionId; resumeId assigned/stable internally. */
export type ResumeSessionInput = {
  sessionId: string;
  sessionFile: string;
  title: string;
  startedAt: string;
  lastSeenAt: string;
  group: SessionGroup;
  worktree: SessionWorktree;
};

export type PruneResumeSessionsOptions = {
  /** Reference time (Date, ms, or ISO). Defaults to now. */
  now?: Date | string | number;
  /** Live session ids that must not be pruned. */
  keepSessionIds?: Iterable<string>;
  /** Max non-protected rows retained (default 1000). */
  maxRows?: number;
  /** Max age in days for non-protected rows (default 90). */
  maxAgeDays?: number;
};

export type LegacyLocationsImportResult = {
  /** True when this call performed the one-time import attempt. */
  ran: boolean;
  /** Valid locations upserted (0 when skipped/missing/corrupt). */
  count: number;
};

type LocationRow = {
  group_path: string;
  worktree_path: string;
  group_kind: string;
  group_name: string;
  worktree_name: string;
  worktree_branch: string | null;
  last_session_started_at: string;
};

type ResumeRow = {
  resume_id: string;
  session_id: string;
  session_file: string;
  title: string;
  started_at: string;
  last_seen_at: string;
  group_kind: string;
  group_name: string;
  group_path: string;
  worktree_name: string;
  worktree_path: string;
  worktree_branch: string | null;
};

const closedDbs = new WeakSet<Database>();

function enforcePrivateFileMode(path: string): void {
  try {
    if (existsSync(path)) chmodSync(path, FILE_MODE);
  } catch {
    // Best-effort: some FS may reject chmod.
  }
}

/** DB file plus WAL/SHM sidecars when present. */
export function enforceDashboardDbFileModes(dbPath: string): void {
  enforcePrivateFileMode(dbPath);
  enforcePrivateFileMode(`${dbPath}-wal`);
  enforcePrivateFileMode(`${dbPath}-shm`);
}

function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as
    | { user_version: number }
    | null
    | undefined;
  return row?.user_version ?? 0;
}

function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
}

/** Create v1 tables + indexes. Caller must run inside a transaction at user_version 0. */
function migrateV0ToV1(db: Database): void {
  db.exec(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE dashboard_locations (
      group_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      group_kind TEXT NOT NULL,
      group_name TEXT NOT NULL,
      worktree_name TEXT NOT NULL,
      worktree_branch TEXT,
      last_session_started_at TEXT NOT NULL,
      PRIMARY KEY (group_path, worktree_path)
    );

    CREATE INDEX dashboard_locations_last_session_started_at_idx
      ON dashboard_locations (last_session_started_at DESC);

    CREATE TABLE resume_sessions (
      resume_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      session_file TEXT NOT NULL,
      title TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      group_kind TEXT NOT NULL,
      group_name TEXT NOT NULL,
      group_path TEXT NOT NULL,
      worktree_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_branch TEXT
    );

    CREATE INDEX resume_sessions_last_seen_at_idx
      ON resume_sessions (last_seen_at DESC);

    CREATE INDEX resume_sessions_worktree_path_idx
      ON resume_sessions (worktree_path);

    CREATE INDEX resume_sessions_group_worktree_idx
      ON resume_sessions (group_path, worktree_path);
  `);
  db.exec(`PRAGMA user_version = ${DASHBOARD_DB_USER_VERSION}`);
}

/**
 * Idempotent migration. Rejects DBs written by a newer schema.
 * v0→v1 is transactional so a failed migrate never bumps user_version.
 */
export function migrateDashboardDb(db: Database): void {
  const version = readUserVersion(db);
  if (version > DASHBOARD_DB_USER_VERSION) {
    throw new Error(
      `dashboard db user_version ${version} is newer than supported ${DASHBOARD_DB_USER_VERSION}`,
    );
  }
  if (version === DASHBOARD_DB_USER_VERSION) return;

  const run = db.transaction(() => {
    const current = readUserVersion(db);
    if (current > DASHBOARD_DB_USER_VERSION) {
      throw new Error(
        `dashboard db user_version ${current} is newer than supported ${DASHBOARD_DB_USER_VERSION}`,
      );
    }
    if (current === DASHBOARD_DB_USER_VERSION) return;
    if (current === 0) {
      migrateV0ToV1(db);
      return;
    }
    throw new Error(`dashboard db user_version ${current} cannot be migrated`);
  });
  run();
}

/**
 * Open (or create) the dashboard DB with private modes, WAL pragmas, and v1 schema.
 * Safe to call repeatedly on an existing file — migration is idempotent.
 */
export function openDashboardDb(
  path = getDashboardDbPath(),
): DashboardDatabase {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(parent, DIR_MODE);
  } catch {
    // Parent may already exist with tighter ownership constraints.
  }

  const db = new Database(path, { create: true });
  try {
    applyPragmas(db);
    enforceDashboardDbFileModes(path);
    migrateDashboardDb(db);
    // WAL/SHM often appear after the first transactional write.
    enforceDashboardDbFileModes(path);
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore close errors during open failure
    }
    throw err;
  }

  return { path, db };
}

export type WalCheckpointMode = "PASSIVE" | "TRUNCATE" | "FULL" | "RESTART";

/** Best-effort WAL checkpoint; never throws to callers. */
export function checkpointDashboardDb(
  handle: DashboardDatabase,
  mode: WalCheckpointMode = "PASSIVE",
): void {
  if (closedDbs.has(handle.db)) return;
  try {
    handle.db.exec(`PRAGMA wal_checkpoint(${mode})`);
  } catch {
    // Checkpoint is best-effort; callers must not crash.
  }
}

/**
 * PASSIVE checkpoint then close. Double-close is a no-op.
 * Does not throw on checkpoint or close failures after the first successful close.
 */
export function closeDashboardDb(handle: DashboardDatabase): void {
  if (closedDbs.has(handle.db)) return;
  checkpointDashboardDb(handle, "PASSIVE");
  try {
    handle.db.close(false);
  } catch {
    try {
      handle.db.close();
    } catch {
      // ignore
    }
  }
  closedDbs.add(handle.db);
  enforceDashboardDbFileModes(handle.path);
}

// ── decoding / validation ─────────────────────────────────────────────

function assertOpen(handle: DashboardDatabase): Database {
  if (closedDbs.has(handle.db)) {
    throw new Error("dashboard db is closed");
  }
  return handle.db;
}

/** Host-only absolute session jsonl path (mirrors contracts private rules). */
function isValidSessionFilePath(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > 1024) return false;
  if (v.includes("\0") || v.includes("\n")) return false;
  if (!v.startsWith("/")) return false;
  return v.endsWith(".jsonl");
}

function isSessionGroupKind(v: unknown): v is SessionGroupKind {
  return v === "repository" || v === "folder";
}

function decodeGroup(
  kind: unknown,
  name: unknown,
  path: unknown,
): SessionGroup {
  if (!isSessionGroupKind(kind)) {
    throw new Error(`invalid group_kind: ${String(kind)}`);
  }
  if (!isNonEmptyString(name, 512)) {
    throw new Error("invalid group_name");
  }
  if (!isNonEmptyString(path, 1024)) {
    throw new Error("invalid group_path");
  }
  return { kind, name, path };
}

function decodeWorktree(
  name: unknown,
  path: unknown,
  branch: unknown,
): SessionWorktree {
  if (!isNonEmptyString(name, 512)) {
    throw new Error("invalid worktree_name");
  }
  if (!isNonEmptyString(path, 1024)) {
    throw new Error("invalid worktree_path");
  }
  if (branch != null && branch !== "") {
    if (!isNonEmptyString(branch, 256)) {
      throw new Error("invalid worktree_branch");
    }
    return { name, path, branch };
  }
  return { name, path };
}

function decodeLocationRow(row: LocationRow): DashboardLocation {
  const group = decodeGroup(row.group_kind, row.group_name, row.group_path);
  const worktree = decodeWorktree(
    row.worktree_name,
    row.worktree_path,
    row.worktree_branch,
  );
  if (!isIsoTimestamp(row.last_session_started_at)) {
    throw new Error("invalid last_session_started_at");
  }
  return {
    group,
    worktree,
    lastSessionStartedAt: row.last_session_started_at,
  };
}

function decodeResumeRow(row: ResumeRow): ResumeSessionRow {
  if (!isValidId(row.resume_id)) throw new Error("invalid resume_id");
  if (!isValidId(row.session_id)) throw new Error("invalid session_id");
  if (!isValidSessionFilePath(row.session_file)) {
    throw new Error("invalid session_file");
  }
  if (!isNonEmptyString(row.title, 256)) throw new Error("invalid title");
  if (!isIsoTimestamp(row.started_at)) throw new Error("invalid started_at");
  if (!isIsoTimestamp(row.last_seen_at)) throw new Error("invalid last_seen_at");
  const group = decodeGroup(row.group_kind, row.group_name, row.group_path);
  const worktree = decodeWorktree(
    row.worktree_name,
    row.worktree_path,
    row.worktree_branch,
  );
  return {
    resumeId: row.resume_id,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    title: row.title,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    group,
    worktree,
  };
}

function assertDashboardLocation(location: DashboardLocation): DashboardLocation {
  const group = parseSessionGroup(location.group);
  const worktree = parseSessionWorktree(location.worktree);
  if (!group || !worktree || !isIsoTimestamp(location.lastSessionStartedAt)) {
    throw new Error("invalid DashboardLocation");
  }
  return {
    group,
    worktree,
    lastSessionStartedAt: location.lastSessionStartedAt,
  };
}

function assertResumeInput(input: ResumeSessionInput): ResumeSessionInput {
  if (!isValidId(input.sessionId)) throw new Error("invalid sessionId");
  if (!isValidSessionFilePath(input.sessionFile)) {
    throw new Error("invalid sessionFile");
  }
  if (!isNonEmptyString(input.title, 256)) throw new Error("invalid title");
  if (!isIsoTimestamp(input.startedAt)) throw new Error("invalid startedAt");
  if (!isIsoTimestamp(input.lastSeenAt)) throw new Error("invalid lastSeenAt");
  const group = parseSessionGroup(input.group);
  const worktree = parseSessionWorktree(input.worktree);
  if (!group || !worktree) throw new Error("invalid group/worktree");
  return {
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    title: input.title,
    startedAt: input.startedAt,
    lastSeenAt: input.lastSeenAt,
    group,
    worktree,
  };
}

function toPublicSummary(row: ResumeSessionRow): RecentSessionSummary {
  return {
    id: row.resumeId,
    title: row.title,
    lastSeenAt: row.lastSeenAt,
    group: row.group,
    worktree: row.worktree,
  };
}

function parseDashboardLocationValue(value: unknown): DashboardLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const group = parseSessionGroup(record.group);
  const worktree = parseSessionWorktree(record.worktree);
  if (!group || !worktree || !isIsoTimestamp(record.lastSessionStartedAt)) {
    return null;
  }
  return { group, worktree, lastSessionStartedAt: record.lastSessionStartedAt };
}

function metaGet(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null
    | undefined;
  return row?.value ?? null;
}

function metaSet(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function laterIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// ── DashboardLocation CRUD (DB-04) ────────────────────────────────────

/** Insert or update a remembered worktree; keeps the later lastSessionStartedAt. */
export function upsertDashboardLocation(
  handle: DashboardDatabase,
  location: DashboardLocation,
): DashboardLocation {
  const db = assertOpen(handle);
  const next = assertDashboardLocation(location);
  const branch = next.worktree.branch ?? null;

  const run = db.transaction(() => {
    const existing = db
      .query(
        `SELECT last_session_started_at AS last_session_started_at
         FROM dashboard_locations
         WHERE group_path = ? AND worktree_path = ?`,
      )
      .get(next.group.path, next.worktree.path) as
      | { last_session_started_at: string }
      | null
      | undefined;

    const lastSessionStartedAt = existing
      ? laterIso(existing.last_session_started_at, next.lastSessionStartedAt)
      : next.lastSessionStartedAt;

    db.query(
      `INSERT INTO dashboard_locations (
         group_path, worktree_path, group_kind, group_name,
         worktree_name, worktree_branch, last_session_started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_path, worktree_path) DO UPDATE SET
         group_kind = excluded.group_kind,
         group_name = excluded.group_name,
         worktree_name = excluded.worktree_name,
         worktree_branch = excluded.worktree_branch,
         last_session_started_at = excluded.last_session_started_at`,
    ).run(
      next.group.path,
      next.worktree.path,
      next.group.kind,
      next.group.name,
      next.worktree.name,
      branch,
      lastSessionStartedAt,
    );

    return {
      ...next,
      lastSessionStartedAt,
    } satisfies DashboardLocation;
  });

  return run();
}

export function getDashboardLocation(
  handle: DashboardDatabase,
  groupPath: string,
  worktreePath: string,
): DashboardLocation | null {
  const db = assertOpen(handle);
  const row = db
    .query(
      `SELECT group_path, worktree_path, group_kind, group_name,
              worktree_name, worktree_branch, last_session_started_at
       FROM dashboard_locations
       WHERE group_path = ? AND worktree_path = ?`,
    )
    .get(groupPath, worktreePath) as LocationRow | null | undefined;
  if (!row) return null;
  return decodeLocationRow(row);
}

/** Locations newest-first by last_session_started_at. */
export function listDashboardLocations(
  handle: DashboardDatabase,
): DashboardLocation[] {
  const db = assertOpen(handle);
  const rows = db
    .query(
      `SELECT group_path, worktree_path, group_kind, group_name,
              worktree_name, worktree_branch, last_session_started_at
       FROM dashboard_locations
       ORDER BY last_session_started_at DESC, group_path ASC, worktree_path ASC`,
    )
    .all() as LocationRow[];
  return rows.map(decodeLocationRow);
}

/**
 * Delete a location and cascade-delete resume rows for the same group/worktree.
 * Returns true when a location row was removed.
 */
export function deleteDashboardLocation(
  handle: DashboardDatabase,
  groupPath: string,
  worktreePath: string,
): boolean {
  const db = assertOpen(handle);
  const run = db.transaction(() => {
    db.query(
      `DELETE FROM resume_sessions
       WHERE group_path = ? AND worktree_path = ?`,
    ).run(groupPath, worktreePath);
    const result = db
      .query(
        `DELETE FROM dashboard_locations
         WHERE group_path = ? AND worktree_path = ?`,
      )
      .run(groupPath, worktreePath);
    return result.changes > 0;
  });
  return run();
}

// ── Resume session CRUD (DB-05) ───────────────────────────────────────

/**
 * Upsert by sessionId. resumeId is stable across updates for the same sessionId.
 * startedAt is preserved on conflict; lastSeenAt takes the later value.
 */
export function upsertResumeSession(
  handle: DashboardDatabase,
  input: ResumeSessionInput,
): ResumeSessionRow {
  const db = assertOpen(handle);
  const next = assertResumeInput(input);
  const branch = next.worktree.branch ?? null;

  const run = db.transaction(() => {
    const existing = db
      .query(
        `SELECT resume_id, started_at, last_seen_at
         FROM resume_sessions
         WHERE session_id = ?`,
      )
      .get(next.sessionId) as
      | { resume_id: string; started_at: string; last_seen_at: string }
      | null
      | undefined;

    const resumeId = existing?.resume_id ?? newId();
    const startedAt = existing?.started_at ?? next.startedAt;
    const lastSeenAt = existing
      ? laterIso(existing.last_seen_at, next.lastSeenAt)
      : next.lastSeenAt;

    db.query(
      `INSERT INTO resume_sessions (
         resume_id, session_id, session_file, title, started_at, last_seen_at,
         group_kind, group_name, group_path, worktree_name, worktree_path, worktree_branch
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         session_file = excluded.session_file,
         title = excluded.title,
         last_seen_at = excluded.last_seen_at,
         group_kind = excluded.group_kind,
         group_name = excluded.group_name,
         group_path = excluded.group_path,
         worktree_name = excluded.worktree_name,
         worktree_path = excluded.worktree_path,
         worktree_branch = excluded.worktree_branch`,
    ).run(
      resumeId,
      next.sessionId,
      next.sessionFile,
      next.title,
      startedAt,
      lastSeenAt,
      next.group.kind,
      next.group.name,
      next.group.path,
      next.worktree.name,
      next.worktree.path,
      branch,
    );

    return decodeResumeRow(
      db
        .query(
          `SELECT resume_id, session_id, session_file, title, started_at, last_seen_at,
                  group_kind, group_name, group_path, worktree_name, worktree_path, worktree_branch
           FROM resume_sessions
           WHERE session_id = ?`,
        )
        .get(next.sessionId) as ResumeRow,
    );
  });

  return run();
}

/** Opaque lookup by resume_id (host-only row including sessionFile). */
export function getResumeSessionByResumeId(
  handle: DashboardDatabase,
  resumeId: string,
): ResumeSessionRow | null {
  const db = assertOpen(handle);
  if (!isValidId(resumeId)) return null;
  const row = db
    .query(
      `SELECT resume_id, session_id, session_file, title, started_at, last_seen_at,
              group_kind, group_name, group_path, worktree_name, worktree_path, worktree_branch
       FROM resume_sessions
       WHERE resume_id = ?`,
    )
    .get(resumeId) as ResumeRow | null | undefined;
  if (!row) return null;
  return decodeResumeRow(row);
}

export function getResumeSessionBySessionId(
  handle: DashboardDatabase,
  sessionId: string,
): ResumeSessionRow | null {
  const db = assertOpen(handle);
  if (!isValidId(sessionId)) return null;
  const row = db
    .query(
      `SELECT resume_id, session_id, session_file, title, started_at, last_seen_at,
              group_kind, group_name, group_path, worktree_name, worktree_path, worktree_branch
       FROM resume_sessions
       WHERE session_id = ?`,
    )
    .get(sessionId) as ResumeRow | null | undefined;
  if (!row) return null;
  return decodeResumeRow(row);
}

/** Advance last_seen_at when the new value is later. Returns updated row or null. */
export function touchResumeSessionLastSeen(
  handle: DashboardDatabase,
  sessionId: string,
  lastSeenAt: string,
): ResumeSessionRow | null {
  const db = assertOpen(handle);
  if (!isValidId(sessionId) || !isIsoTimestamp(lastSeenAt)) return null;

  const run = db.transaction(() => {
    const existing = db
      .query(
        `SELECT resume_id, last_seen_at FROM resume_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { resume_id: string; last_seen_at: string }
      | null
      | undefined;
    if (!existing) return null;

    const nextLastSeen = laterIso(existing.last_seen_at, lastSeenAt);
    if (nextLastSeen !== existing.last_seen_at) {
      db.query(
        `UPDATE resume_sessions SET last_seen_at = ? WHERE session_id = ?`,
      ).run(nextLastSeen, sessionId);
    }

    return getResumeSessionBySessionId(handle, sessionId);
  });

  return run();
}

/**
 * Public recent-session candidates newest-first.
 * `id` is resumeId. Excludes rows whose sessionId is in excludeSessionIds.
 * Never includes sessionFile or other host-only fields.
 */
export function listResumeSessionCandidates(
  handle: DashboardDatabase,
  excludeSessionIds: Iterable<string> = [],
): RecentSessionSummary[] {
  const db = assertOpen(handle);
  const exclude = new Set(excludeSessionIds);
  const rows = db
    .query(
      `SELECT resume_id, session_id, session_file, title, started_at, last_seen_at,
              group_kind, group_name, group_path, worktree_name, worktree_path, worktree_branch
       FROM resume_sessions
       ORDER BY last_seen_at DESC, resume_id ASC`,
    )
    .all() as ResumeRow[];

  const out: RecentSessionSummary[] = [];
  for (const row of rows) {
    if (exclude.has(row.session_id)) continue;
    out.push(toPublicSummary(decodeResumeRow(row)));
  }
  return out;
}

export function deleteResumeSessionByResumeId(
  handle: DashboardDatabase,
  resumeId: string,
): boolean {
  const db = assertOpen(handle);
  if (!isValidId(resumeId)) return false;
  const result = db
    .query(`DELETE FROM resume_sessions WHERE resume_id = ?`)
    .run(resumeId);
  return result.changes > 0;
}

export function deleteResumeSessionBySessionId(
  handle: DashboardDatabase,
  sessionId: string,
): boolean {
  const db = assertOpen(handle);
  if (!isValidId(sessionId)) return false;
  const result = db
    .query(`DELETE FROM resume_sessions WHERE session_id = ?`)
    .run(sessionId);
  return result.changes > 0;
}

// ── Legacy locations JSON import (DB-06) ──────────────────────────────

/**
 * One-time import of omp-sessions-share-locations.json into dashboard_locations.
 * - Uses public group/worktree parsers only (no resume rows created).
 * - Never modifies the source file (byte-preserving).
 * - Missing/corrupt file: marks imported and returns count 0 (no throw).
 * - Subsequent calls are no-ops once the meta flag is set.
 */
export function importLegacyDashboardLocations(
  handle: DashboardDatabase,
  locationsPath: string,
): LegacyLocationsImportResult {
  const db = assertOpen(handle);

  const run = db.transaction(() => {
    if (metaGet(db, LEGACY_LOCATIONS_IMPORT_META_KEY) === "1") {
      return { ran: false, count: 0 } satisfies LegacyLocationsImportResult;
    }

    let count = 0;
    try {
      if (existsSync(locationsPath)) {
        const raw = readFileSync(locationsPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          (parsed as { version?: unknown }).version === 1 &&
          Array.isArray((parsed as { locations?: unknown }).locations)
        ) {
          for (const value of (parsed as { locations: unknown[] }).locations) {
            const location = parseDashboardLocationValue(value);
            if (!location) continue;
            upsertDashboardLocation(handle, location);
            count += 1;
          }
        }
      }
    } catch {
      // Missing or invalid history starts empty; still mark imported.
      count = 0;
    }

    metaSet(db, LEGACY_LOCATIONS_IMPORT_META_KEY, "1");
    return { ran: true, count } satisfies LegacyLocationsImportResult;
  });

  return run();
}

// ── Retention pruning (DB-07) ─────────────────────────────────────────

function toEpochMs(now: Date | string | number | undefined): number {
  if (now === undefined) return Date.now();
  if (typeof now === "number") {
    if (!Number.isFinite(now)) throw new Error("invalid now");
    return now;
  }
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) throw new Error("invalid now");
    return ms;
  }
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) throw new Error("invalid now");
  return ms;
}

/**
 * Deterministic retention:
 * 1. Never delete rows whose session_id is in keepSessionIds.
 * 2. Delete non-protected rows with last_seen_at older than maxAgeDays.
 * 3. Among remaining non-protected rows, keep the newest maxRows; delete the rest.
 * Returns number of deleted rows.
 */
export function pruneResumeSessions(
  handle: DashboardDatabase,
  options: PruneResumeSessionsOptions = {},
): number {
  const db = assertOpen(handle);
  const maxRows = options.maxRows ?? RESUME_SESSION_MAX_ROWS;
  const maxAgeDays = options.maxAgeDays ?? RESUME_SESSION_MAX_AGE_DAYS;
  if (!Number.isInteger(maxRows) || maxRows < 0) {
    throw new Error("invalid maxRows");
  }
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    throw new Error("invalid maxAgeDays");
  }

  const nowMs = toEpochMs(options.now);
  const cutoffMs = nowMs - maxAgeDays * 86_400_000;
  const keep = new Set(options.keepSessionIds ?? []);

  const run = db.transaction(() => {
    const rows = db
      .query(
        `SELECT resume_id, session_id, last_seen_at
         FROM resume_sessions
         ORDER BY last_seen_at DESC, resume_id ASC`,
      )
      .all() as Array<{
      resume_id: string;
      session_id: string;
      last_seen_at: string;
    }>;

    const doomed: string[] = [];
    let keptNonProtected = 0;

    for (const row of rows) {
      if (keep.has(row.session_id)) continue;

      const seenMs = Date.parse(row.last_seen_at);
      if (!Number.isFinite(seenMs) || seenMs < cutoffMs) {
        doomed.push(row.resume_id);
        continue;
      }

      if (keptNonProtected >= maxRows) {
        doomed.push(row.resume_id);
        continue;
      }
      keptNonProtected += 1;
    }

    if (doomed.length === 0) return 0;

    let deleted = 0;
    const chunkSize = 64;
    for (let i = 0; i < doomed.length; i += chunkSize) {
      const chunk = doomed.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = db
        .query(`DELETE FROM resume_sessions WHERE resume_id IN (${placeholders})`)
        .run(...chunk);
      deleted += result.changes;
    }
    return deleted;
  });

  return run();
}
