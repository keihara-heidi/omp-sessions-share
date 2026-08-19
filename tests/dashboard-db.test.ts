import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getDashboardDbPath, getDashboardLocationsPath } from "../shared/config";
import {
  DASHBOARD_DB_USER_VERSION,
  LEGACY_LOCATIONS_IMPORT_META_KEY,
  RESUME_SESSION_MAX_AGE_DAYS,
  RESUME_SESSION_MAX_ROWS,
  checkpointDashboardDb,
  closeDashboardDb,
  deleteDashboardLocation,
  deleteResumeSessionByResumeId,
  deleteResumeSessionBySessionId,
  getDashboardLocation,
  getResumeSessionByResumeId,
  getResumeSessionBySessionId,
  importLegacyDashboardLocations,
  listDashboardLocations,
  listFavoriteRepositoryPaths,
  listResumeSessionCandidates,
  openDashboardDb,
  pruneResumeSessions,
  setFavoriteRepository,
  touchResumeSessionLastSeen,
  upsertDashboardLocation,
  upsertResumeSession,
  type DashboardDatabase,
  type ResumeSessionInput,
} from "../daemon/dashboard-db";

const tempDirs: string[] = [];
const openHandles: DashboardDatabase[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openTempDb(name = "omp-sessions-share.sqlite"): DashboardDatabase {
  const dir = makeTemp("omp-dash-db-");
  const handle = openDashboardDb(join(dir, name));
  openHandles.push(handle);
  return handle;
}

afterEach(() => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop()!;
    try {
      closeDashboardDb(handle);
    } catch {
      // test cleanup
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getDashboardDbPath", () => {
  test("joins root without touching HOME", () => {
    const root = "/tmp/omp-agent-test-root";
    expect(getDashboardDbPath(root)).toBe(join(root, "omp-sessions-share.sqlite"));
    expect(getDashboardLocationsPath(root)).toBe(
      join(root, "omp-sessions-share-locations.json"),
    );
  });

  test("defaults beside agent config under temp PI_CODING_AGENT_DIR", () => {
    const agent = makeTemp("omp-dash-path-");
    const prev = process.env.PI_CODING_AGENT_DIR;
    const prevHome = process.env.HOME;
    try {
      process.env.PI_CODING_AGENT_DIR = agent;
      process.env.HOME = join(agent, "outside-home");
      expect(getDashboardDbPath()).toBe(join(agent, "omp-sessions-share.sqlite"));
      expect(getDashboardDbPath().startsWith(process.env.HOME)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("open/close permissions", () => {
  test("creates parent 0700, db 0600, WAL active", () => {
    const agent = makeTemp("omp-dash-perm-");
    const nested = join(agent, "nested", "agent");
    const path = join(nested, "omp-sessions-share.sqlite");
    const handle = openDashboardDb(path);
    openHandles.push(handle);

    const dirMode = statSync(nested).mode & 0o777;
    const fileMode = statSync(path).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    const journal = handle.db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journal.journal_mode.toLowerCase()).toBe("wal");

    const sync = handle.db.query("PRAGMA synchronous").get() as {
      synchronous: number;
    };
    expect(sync.synchronous).toBe(1); // NORMAL

    const fk = handle.db.query("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(fk.foreign_keys).toBe(1);

    const busy = handle.db.query("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(busy.timeout).toBe(5000);

    // Touch WAL sidecars and re-enforce.
    handle.db.exec("INSERT INTO meta(key, value) VALUES ('probe', '1')");
    checkpointDashboardDb(handle, "PASSIVE");
    if (existsSync(`${path}-wal`)) {
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    }
    if (existsSync(`${path}-shm`)) {
      expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
    }
  });

  test("re-open is idempotent and preserves data", () => {
    const dir = makeTemp("omp-dash-reopen-");
    const path = join(dir, "db.sqlite");
    const first = openDashboardDb(path);
    first.db.exec("INSERT INTO meta(key, value) VALUES ('k', 'v')");
    closeDashboardDb(first);

    const second = openDashboardDb(path);
    openHandles.push(second);
    const row = second.db.query("SELECT value FROM meta WHERE key = 'k'").get() as {
      value: string;
    };
    expect(row.value).toBe("v");
    const version = second.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(DASHBOARD_DB_USER_VERSION);
  });

  test("double close is safe", () => {
    const handle = openTempDb();
    closeDashboardDb(handle);
    closeDashboardDb(handle);
  });
});

describe("migrate dashboard schema", () => {
  test("fresh DB ends at current user_version with all tables and indexes", () => {
    const handle = openTempDb();
    const version = handle.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(DASHBOARD_DB_USER_VERSION);

    const tables = handle.db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      "dashboard_locations",
      "favorite_repositories",
      "meta",
      "resume_sessions",
    ]);

    const indexes = handle.db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain(
      "dashboard_locations_last_session_started_at_idx",
    );
    expect(indexes.map((i) => i.name)).toContain("resume_sessions_last_seen_at_idx");
    expect(indexes.map((i) => i.name)).toContain("resume_sessions_worktree_path_idx");
    expect(indexes.map((i) => i.name)).toContain("resume_sessions_group_worktree_idx");
  });

  test("opening a current DB is a no-op migration", () => {
    const dir = makeTemp("omp-dash-v1-");
    const path = join(dir, "db.sqlite");
    const first = openDashboardDb(path);
    first.db.exec("INSERT INTO meta(key, value) VALUES ('legacy_flag', '1')");
    closeDashboardDb(first);

    const second = openDashboardDb(path);
    openHandles.push(second);
    const count = second.db.query("SELECT COUNT(*) AS c FROM meta").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
    const version = second.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(DASHBOARD_DB_USER_VERSION);
  });

  test("v1 resume rows migrate with workspace origin", () => {
    const dir = makeTemp("omp-dash-v1-origin-");
    const path = join(dir, "db.sqlite");
    const raw = new Database(path, { create: true });
    raw.exec(`
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
      PRAGMA user_version = 1;
    `);
    raw.close();

    const migrated = openDashboardDb(path);
    openHandles.push(migrated);
    const columns = migrated.db.query("PRAGMA table_info(resume_sessions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("origin");
    const migratedVersion = migrated.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(migratedVersion.user_version).toBe(DASHBOARD_DB_USER_VERSION);
  });

  test("v2 DB migrates to v3 with empty favorites and intact locations", () => {
    const dir = makeTemp("omp-dash-v2-fav-");
    const path = join(dir, "db.sqlite");
    const raw = new Database(path, { create: true });
    raw.exec(`
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
      CREATE TABLE resume_sessions (
        resume_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        session_file TEXT NOT NULL,
        title TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'workspace',
        group_kind TEXT NOT NULL,
        group_name TEXT NOT NULL,
        group_path TEXT NOT NULL,
        worktree_name TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        worktree_branch TEXT
      );
      INSERT INTO dashboard_locations (
        group_path, worktree_path, group_kind, group_name,
        worktree_name, worktree_branch, last_session_started_at
      ) VALUES (
        '/repo', '/repo', 'repository', 'repo',
        'repo', 'main', '2026-08-12T00:00:00.000Z'
      );
      PRAGMA user_version = 2;
    `);
    raw.close();

    const migrated = openDashboardDb(path);
    openHandles.push(migrated);
    const version = migrated.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(3);
    expect(listFavoriteRepositoryPaths(migrated)).toEqual([]);
    expect(listDashboardLocations(migrated)).toEqual([
      {
        group: { kind: "repository", name: "repo", path: "/repo" },
        worktree: { name: "repo", path: "/repo", branch: "main" },
        lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
      },
    ]);
  });

  test("rejects future user_version", () => {
    const dir = makeTemp("omp-dash-future-");
    const path = join(dir, "db.sqlite");
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    expect(() => openDashboardDb(path)).toThrow(/user_version 99/);
  });

  test("session_id UNIQUE and resume_id PK enforced", () => {
    const handle = openTempDb();
    handle.db
      .query(
        `INSERT INTO resume_sessions (
          resume_id, session_id, session_file, title, started_at, last_seen_at,
          group_kind, group_name, group_path, worktree_name, worktree_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "r1",
        "s1",
        "/tmp/session.jsonl",
        "t",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
        "folder",
        "tmp",
        "/tmp",
        "tmp",
        "/tmp",
      );

    expect(() =>
      handle.db
        .query(
          `INSERT INTO resume_sessions (
            resume_id, session_id, session_file, title, started_at, last_seen_at,
            group_kind, group_name, group_path, worktree_name, worktree_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "r1",
          "s2",
          "/tmp/other.jsonl",
          "t2",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:01.000Z",
          "folder",
          "tmp",
          "/tmp",
          "tmp",
          "/tmp",
        ),
    ).toThrow();

    expect(() =>
      handle.db
        .query(
          `INSERT INTO resume_sessions (
            resume_id, session_id, session_file, title, started_at, last_seen_at,
            group_kind, group_name, group_path, worktree_name, worktree_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "r2",
          "s1",
          "/tmp/other.jsonl",
          "t2",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:01.000Z",
          "folder",
          "tmp",
          "/tmp",
          "tmp",
          "/tmp",
        ),
    ).toThrow();
  });

  test("failed mid-migrate does not bump user_version", () => {
    const dir = makeTemp("omp-dash-fail-");
    const path = join(dir, "db.sqlite");
    // Pre-create a conflicting table name so CREATE TABLE meta would still work
    // but we simulate by opening raw and forcing a broken partial state at v0
    // with a non-table object isn't easy; instead verify transactional rollback
    // by running a failing transaction that includes user_version bump.
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA journal_mode = WAL");
    try {
      const boom = raw.transaction(() => {
        raw.exec(`
          CREATE TABLE meta (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
          );
        `);
        raw.exec("PRAGMA user_version = 1");
        throw new Error("force rollback");
      });
      boom();
    } catch {
      // expected
    }
    const version = raw.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(0);
    const tables = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`,
      )
      .get();
    expect(tables).toBeNull();
    raw.close();

    // Real open still migrates cleanly from the rolled-back v0 file.
    const handle = openDashboardDb(path);
    openHandles.push(handle);
    const v = handle.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(v.user_version).toBe(DASHBOARD_DB_USER_VERSION);
  });
});

describe("checkpoint close", () => {
  test("close after writes leaves DB re-openable with rows", () => {
    const dir = makeTemp("omp-dash-ckpt-");
    const path = join(dir, "db.sqlite");
    const handle = openDashboardDb(path);
    handle.db.exec(
      `INSERT INTO dashboard_locations (
        group_path, worktree_path, group_kind, group_name,
        worktree_name, worktree_branch, last_session_started_at
      ) VALUES (
        '/repo', '/repo', 'repository', 'repo',
        'repo', 'main', '2026-01-01T00:00:00.000Z'
      )`,
    );
    checkpointDashboardDb(handle, "TRUNCATE");
    closeDashboardDb(handle);

    const again = openDashboardDb(path);
    openHandles.push(again);
    const row = again.db
      .query("SELECT group_name FROM dashboard_locations")
      .get() as { group_name: string };
    expect(row.group_name).toBe("repo");
  });

  test("checkpoint failure is swallowed", () => {
    const handle = openTempDb();
    closeDashboardDb(handle);
    // After close, checkpoint is a no-op (closed set) — must not throw.
    checkpointDashboardDb(handle, "PASSIVE");
    checkpointDashboardDb(handle, "TRUNCATE");
  });

  test("loosened modes are repaired on open when sidecars exist", () => {
    const dir = makeTemp("omp-dash-mode-");
    const path = join(dir, "db.sqlite");
    const handle = openDashboardDb(path);
    handle.db.exec("INSERT INTO meta(key, value) VALUES ('x', '1')");
    closeDashboardDb(handle);

    chmodSync(path, 0o644);
    if (existsSync(`${path}-wal`)) chmodSync(`${path}-wal`, 0o644);
    if (existsSync(`${path}-shm`)) chmodSync(`${path}-shm`, 0o644);

    const again = openDashboardDb(path);
    openHandles.push(again);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    if (existsSync(`${path}-wal`)) {
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    }
    if (existsSync(`${path}-shm`)) {
      expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
    }
  });
});

const sampleGroup = {
  kind: "repository" as const,
  name: "repo",
  path: "/tmp/repo",
};
const sampleWorktree = {
  name: "main",
  path: "/tmp/repo",
  branch: "main",
};

function resumeInput(
  overrides: Partial<ResumeSessionInput> & Pick<ResumeSessionInput, "sessionId">,
): ResumeSessionInput {
  return {
    sessionFile: `/tmp/sessions/${overrides.sessionId}.jsonl`,
    title: "title",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:01.000Z",
    origin: "workspace",
    group: sampleGroup,
    worktree: sampleWorktree,
    ...overrides,
  };
}

describe("dashboard location CRUD", () => {
  test("upsert get list and max lastSessionStartedAt", () => {
    const handle = openTempDb();
    const older = upsertDashboardLocation(handle, {
      group: sampleGroup,
      worktree: sampleWorktree,
      lastSessionStartedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(older.lastSessionStartedAt).toBe("2026-02-01T00:00:00.000Z");

    const kept = upsertDashboardLocation(handle, {
      group: sampleGroup,
      worktree: { ...sampleWorktree, name: "main-renamed" },
      lastSessionStartedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(kept.lastSessionStartedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(kept.worktree.name).toBe("main-renamed");

    upsertDashboardLocation(handle, {
      group: { kind: "folder", name: "other", path: "/tmp/other" },
      worktree: { name: "other", path: "/tmp/other" },
      lastSessionStartedAt: "2026-03-01T00:00:00.000Z",
    });

    const listed = listDashboardLocations(handle);
    expect(listed.map((l) => l.group.path)).toEqual(["/tmp/other", "/tmp/repo"]);
    expect(getDashboardLocation(handle, "/tmp/repo", "/tmp/repo")?.worktree.name).toBe(
      "main-renamed",
    );
  });

  test("delete cascades resume rows for same group/worktree", () => {
    const handle = openTempDb();
    upsertDashboardLocation(handle, {
      group: sampleGroup,
      worktree: sampleWorktree,
      lastSessionStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const a = upsertResumeSession(
      handle,
      resumeInput({ sessionId: "live-a", group: sampleGroup, worktree: sampleWorktree }),
    );
    const b = upsertResumeSession(
      handle,
      resumeInput({
        sessionId: "other-b",
        group: { kind: "folder", name: "x", path: "/tmp/x" },
        worktree: { name: "x", path: "/tmp/x" },
      }),
    );

    expect(deleteDashboardLocation(handle, sampleGroup.path, sampleWorktree.path)).toBe(true);
    expect(getDashboardLocation(handle, sampleGroup.path, sampleWorktree.path)).toBeNull();
    expect(getResumeSessionByResumeId(handle, a.resumeId)).toBeNull();
    expect(getResumeSessionByResumeId(handle, b.resumeId)?.sessionId).toBe("other-b");
    expect(deleteDashboardLocation(handle, sampleGroup.path, sampleWorktree.path)).toBe(false);
  });
});

describe("favorite repository CRUD", () => {
  test("set true is idempotent and false removes", () => {
    const handle = openTempDb();
    expect(listFavoriteRepositoryPaths(handle)).toEqual([]);

    setFavoriteRepository(handle, "/repos/a", true);
    setFavoriteRepository(handle, "/repos/b", true);
    setFavoriteRepository(handle, "/repos/a", true);
    expect(listFavoriteRepositoryPaths(handle)).toEqual([
      "/repos/a",
      "/repos/b",
    ]);

    setFavoriteRepository(handle, "/repos/a", false);
    setFavoriteRepository(handle, "/repos/a", false);
    expect(listFavoriteRepositoryPaths(handle)).toEqual(["/repos/b"]);

    setFavoriteRepository(handle, "/repos/b", false);
    expect(listFavoriteRepositoryPaths(handle)).toEqual([]);
  });

  test("group_path primary key uniqueness enforced", () => {
    const handle = openTempDb();
    handle.db
      .query(`INSERT INTO favorite_repositories (group_path) VALUES (?)`)
      .run("/repo");
    expect(() =>
      handle.db
        .query(`INSERT INTO favorite_repositories (group_path) VALUES (?)`)
        .run("/repo"),
    ).toThrow();
  });
});

describe("resume session CRUD", () => {
  test("stable resumeId on sessionId upsert and lastSeen max", () => {
    const handle = openTempDb();
    const first = upsertResumeSession(
      handle,
      resumeInput({
        sessionId: "sess-1",
        title: "one",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:10.000Z",
      }),
    );
    const second = upsertResumeSession(
      handle,
      resumeInput({
        sessionId: "sess-1",
        title: "two",
        sessionFile: "/tmp/sessions/sess-1-b.jsonl",
        startedAt: "2026-06-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:05.000Z",
      }),
    );

    expect(second.resumeId).toBe(first.resumeId);
    expect(second.title).toBe("two");
    expect(second.sessionFile).toBe("/tmp/sessions/sess-1-b.jsonl");
    expect(second.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(second.lastSeenAt).toBe("2026-01-01T00:00:10.000Z");

    const touched = touchResumeSessionLastSeen(
      handle,
      "sess-1",
      "2026-01-02T00:00:00.000Z",
    );
    expect(touched?.lastSeenAt).toBe("2026-01-02T00:00:00.000Z");
    expect(getResumeSessionBySessionId(handle, "sess-1")?.resumeId).toBe(first.resumeId);
    expect(getResumeSessionByResumeId(handle, first.resumeId)?.sessionFile).toBe(
      "/tmp/sessions/sess-1-b.jsonl",
    );
  });

  test("list candidates is public shape without sessionFile and excludes live ids", () => {
    const handle = openTempDb();
    const older = upsertResumeSession(
      handle,
      resumeInput({
        sessionId: "old",
        title: "older",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const newer = upsertResumeSession(
      handle,
      resumeInput({
        sessionId: "new",
        title: "newer",
        lastSeenAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    const live = upsertResumeSession(
      handle,
      resumeInput({
        sessionId: "live",
        title: "live",
        lastSeenAt: "2026-01-03T00:00:00.000Z",
      }),
    );

    const listed = listResumeSessionCandidates(handle, ["live"]);
    expect(listed.map((r) => r.id)).toEqual([newer.resumeId, older.resumeId]);
    expect(listed.some((r) => r.id === live.resumeId)).toBe(false);
    for (const row of listed) {
      expect(row).toEqual({
        id: row.id,
        title: row.title,
        lastSeenAt: row.lastSeenAt,
        origin: row.origin,
        group: row.group,
        worktree: row.worktree,
      });
      expect("sessionFile" in row).toBe(false);
      expect("sessionId" in row).toBe(false);
    }
  });

  test("delete by resumeId and sessionId", () => {
    const handle = openTempDb();
    const a = upsertResumeSession(handle, resumeInput({ sessionId: "del-a" }));
    const b = upsertResumeSession(handle, resumeInput({ sessionId: "del-b" }));
    expect(deleteResumeSessionByResumeId(handle, a.resumeId)).toBe(true);
    expect(getResumeSessionByResumeId(handle, a.resumeId)).toBeNull();
    expect(deleteResumeSessionBySessionId(handle, b.sessionId)).toBe(true);
    expect(getResumeSessionBySessionId(handle, "del-b")).toBeNull();
  });
});

describe("legacy locations import", () => {
  test("imports once, preserves source bytes, skips resume rows", () => {
    const dir = makeTemp("omp-dash-legacy-");
    const locationsPath = join(dir, "omp-sessions-share-locations.json");
    const payload = {
      version: 1,
      locations: [
        {
          group: sampleGroup,
          worktree: sampleWorktree,
          lastSessionStartedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          group: { kind: "nope", name: "bad", path: "/bad" },
          worktree: { name: "bad", path: "/bad" },
          lastSessionStartedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const original = `${JSON.stringify(payload, null, 2)}\n`;
    writeFileSync(locationsPath, original, { mode: 0o600 });

    const handle = openTempDb();
    const first = importLegacyDashboardLocations(handle, locationsPath);
    expect(first).toEqual({ ran: true, count: 1 });
    expect(listDashboardLocations(handle)).toHaveLength(1);
    expect(listResumeSessionCandidates(handle)).toEqual([]);
    expect(readFileSync(locationsPath, "utf8")).toBe(original);

    const second = importLegacyDashboardLocations(handle, locationsPath);
    expect(second).toEqual({ ran: false, count: 0 });
    expect(listDashboardLocations(handle)).toHaveLength(1);

    const flag = handle.db
      .query("SELECT value FROM meta WHERE key = ?")
      .get(LEGACY_LOCATIONS_IMPORT_META_KEY) as { value: string };
    expect(flag.value).toBe("1");
  });

  test("missing or corrupt file marks imported without throw", () => {
    const handle = openTempDb();
    const missing = importLegacyDashboardLocations(
      handle,
      join(makeTemp("omp-dash-missing-"), "nope.json"),
    );
    expect(missing).toEqual({ ran: true, count: 0 });

    const dir = makeTemp("omp-dash-corrupt-");
    const path = join(dir, "locations.json");
    writeFileSync(path, "{not-json", { mode: 0o600 });
    // flag already set from missing path on same handle — use fresh db
    const handle2 = openTempDb();
    const corrupt = importLegacyDashboardLocations(handle2, path);
    expect(corrupt).toEqual({ ran: true, count: 0 });
    expect(importLegacyDashboardLocations(handle2, path)).toEqual({
      ran: false,
      count: 0,
    });
  });
});

describe("resume retention prune", () => {
  test("drops aged rows, caps max rows, protects live session ids", () => {
    const handle = openTempDb();
    const now = Date.parse("2026-06-01T00:00:00.000Z");

    const protectedOld = upsertResumeSession(
      handle,
      resumeInput({
        sessionId: "live-old",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
      }),
    );
    const aged = upsertResumeSession(
      handle,
      resumeInput({
        sessionId: "aged",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
      }),
    );
    const recentIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const row = upsertResumeSession(
        handle,
        resumeInput({
          sessionId: `recent-${i}`,
          lastSeenAt: `2026-05-0${i + 1}T00:00:00.000Z`,
        }),
      );
      recentIds.push(row.sessionId);
    }

    expect(RESUME_SESSION_MAX_AGE_DAYS).toBe(90);
    expect(RESUME_SESSION_MAX_ROWS).toBe(1000);

    const deleted = pruneResumeSessions(handle, {
      now,
      keepSessionIds: ["live-old"],
      maxRows: 3,
      maxAgeDays: 90,
    });
    // aged gone; among 5 recent keep 3 newest; protected old kept
    expect(deleted).toBe(1 + 2);
    expect(getResumeSessionBySessionId(handle, protectedOld.sessionId)?.resumeId).toBe(
      protectedOld.resumeId,
    );
    expect(getResumeSessionBySessionId(handle, aged.sessionId)).toBeNull();

    const remaining = listResumeSessionCandidates(handle);
    const remainingSessionIds = remaining.map(
      (r) => getResumeSessionByResumeId(handle, r.id)!.sessionId,
    );
    expect(remainingSessionIds.sort()).toEqual(
      ["live-old", "recent-4", "recent-3", "recent-2"].sort(),
    );

    // deterministic second pass
    expect(
      pruneResumeSessions(handle, {
        now,
        keepSessionIds: ["live-old"],
        maxRows: 3,
        maxAgeDays: 90,
      }),
    ).toBe(0);
  });
});
