import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUEST_TTL_SECONDS,
  SESSION_TTL_SECONDS,
} from "../lib/contracts";
import {
  LOGIN_ATTEMPT_MAX,
  RECENT_SESSIONS_DISPLAY_LIMIT,
  closeDashboardPersistence,
  configureDashboardDb,
  configureDashboardLocationPersistence,
  consumeLoginAttempt,
  createRequest,
  deactivateSession,
  deleteResumeSession,
  exclusiveSessionPid,
  flushDashboardDb,
  flushDirtyLastSeen,
  getRequest,
  getResumeSession,
  getSession,
  getSessionDashboard,
  listRecentSessions,
  listRequestsBySession,
  listSessions,
  registerDashboardLocations,
  removeDashboardLocation,
  resetStoreForTests,
  setNowForTests,
  setResumeLastSeenFlushMsForTests,
  subscribeSessionChanges,
  upsertSession,
} from "../daemon/store";
import type { SessionChangeListener } from "../daemon/store";

const pubJwk = {
  kty: "RSA",
  alg: "RSA-OAEP-256",
  use: "enc",
  key_ops: ["encrypt"],
  n: "x".repeat(342),
  e: "AQAB",
} as JsonWebKey;

const t0 = 1_700_000_000_000;

beforeEach(() => {
  resetStoreForTests();
  setNowForTests(() => t0);
});

afterEach(() => resetStoreForTests());

describe("daemon store TTL pruning", () => {
  test("sessions expire after SESSION_TTL_SECONDS", () => {
    const created = upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(created.id).toBe("s1");
    expect(created.group).toMatchObject({
      kind: expect.stringMatching(/^(repository|folder)$/),
      name: expect.any(String),
      path: expect.any(String),
    });
    expect(created.worktree).toMatchObject({
      name: expect.any(String),
      path: expect.any(String),
    });
    expect(getSession("s1")).not.toBeNull();
    expect(getSession("s1")?.id).toBe("s1");
    expect(listSessions()).toHaveLength(1);
    expect(listSessions()[0]?.id).toBe("s1");

    setNowForTests(() => t0 + SESSION_TTL_SECONDS * 1000);
    expect(getSession("s1")).toBeNull();
    expect(listSessions()).toEqual([]);
    expect(getSessionDashboard()).toMatchObject({
      sessions: [],
      locations: [
        {
          group: created.group,
          worktree: created.worktree,
          lastSessionStartedAt: created.startedAt,
        },
      ],
      recentSessions: [],
    });
  });

  test("dashboard locations survive daemon store reloads until explicitly removed", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-location-history-"));
    const cwd = join(root, "project");
    const dbPath = join(root, "omp-sessions-share.sqlite");
    mkdirSync(cwd);
    try {
      configureDashboardDb(dbPath);
      const session = upsertSession({
        id: "persisted-session",
        title: "Persistent",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
      });

      resetStoreForTests();
      configureDashboardDb(dbPath);
      expect(getSessionDashboard()).toMatchObject({
        sessions: [],
        locations: [
          {
            group: session.group,
            worktree: session.worktree,
            lastSessionStartedAt: session.startedAt,
          },
        ],
        recentSessions: [],
      });

      expect(
        removeDashboardLocation(session.group.path, session.worktree.path),
      ).toBe(true);
      resetStoreForTests();
      configureDashboardDb(dbPath);
      expect(getSessionDashboard().locations).toEqual([]);
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy locations JSON imports once via DB bootstrap", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-legacy-loc-"));
    const dbPath = join(root, "dash.sqlite");
    const locationsPath = join(root, "omp-sessions-share-locations.json");
    const group = {
      kind: "folder" as const,
      name: "project",
      path: join(root, "project"),
    };
    const worktree = { name: "project", path: group.path };
    writeFileSync(
      locationsPath,
      `${JSON.stringify({
        version: 1,
        locations: [
          {
            group,
            worktree,
            lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    try {
      configureDashboardDb(dbPath, locationsPath);
      expect(getSessionDashboard().locations).toEqual([
        {
          group,
          worktree,
          lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
        },
      ]);

      writeFileSync(locationsPath, "corrupt", { mode: 0o600 });
      resetStoreForTests();
      configureDashboardDb(dbPath, locationsPath);
      expect(getSessionDashboard().locations).toHaveLength(1);
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configureDashboardLocationPersistence opens sqlite beside legacy json", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-loc-alias-"));
    const locationsPath = join(root, "locations.json");
    try {
      configureDashboardLocationPersistence(locationsPath);
      registerDashboardLocations([
        {
          group: { kind: "folder", name: "x", path: "/tmp/x" },
          worktree: { name: "x", path: "/tmp/x" },
          lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
        },
      ]);
      closeDashboardPersistence();
      configureDashboardDb(`${locationsPath}.sqlite`);
      expect(getSessionDashboard().locations).toHaveLength(1);
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("heartbeat refreshes session TTL and keeps stable id + nested metadata", () => {
    const first = upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    setNowForTests(() => t0 + (SESSION_TTL_SECONDS - 1) * 1000);
    const second = upsertSession({
      id: "s1",
      title: "t2",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    setNowForTests(() => t0 + (SESSION_TTL_SECONDS + 5) * 1000);
    const live = getSession("s1");
    expect(live).toMatchObject({
      id: "s1",
      title: "t2",
      cwd: "/tmp",
      group: first.group,
      worktree: first.worktree,
    });
    expect(second.id).toBe("s1");
    expect(second.group).toEqual(first.group);
    expect(second.worktree).toEqual(first.worktree);
  });

  test("requests expire after REQUEST_TTL_SECONDS and prune from index", () => {
    upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const req = createRequest({
      sessionId: "s1",
      deviceName: "phone",
      publicKeyJwk: pubJwk,
    });
    expect(getRequest(req.id)?.status).toBe("pending");
    expect(listRequestsBySession("s1")).toHaveLength(1);

    setNowForTests(() => t0 + (REQUEST_TTL_SECONDS - 1) * 1000);
    upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    setNowForTests(() => t0 + REQUEST_TTL_SECONDS * 1000);
    expect(getRequest(req.id)).toBeNull();
    expect(listRequestsBySession("s1")).toEqual([]);
  });

  test("listSessions preserves mobile session ids with group/worktree", () => {
    upsertSession({
      id: "mobile-session-1",
      title: "Phone target",
      cwd: "/tmp/a",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    setNowForTests(() => t0 + 1000);
    upsertSession({
      id: "mobile-session-2",
      title: "Tablet target",
      cwd: "/tmp/b",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const listed = listSessions();
    expect(listed.map((s) => s.id)).toEqual([
      "mobile-session-2",
      "mobile-session-1",
    ]);
    for (const s of listed) {
      expect(s.group.kind === "repository" || s.group.kind === "folder").toBe(
        true,
      );
      expect(s.group.name.length).toBeGreaterThan(0);
      expect(s.group.path.length).toBeGreaterThan(0);
      expect(s.worktree.name.length).toBeGreaterThan(0);
      expect(s.worktree.path.length).toBeGreaterThan(0);
    }
  });
});

describe("resume session durability", () => {
  test("sessionFile heartbeats persist private resume identity across restarts", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-resume-dur-"));
    const dbPath = join(root, "dash.sqlite");
    const cwd = join(root, "proj");
    mkdirSync(cwd);
    const sessionFile = join(root, "sess-1.jsonl");
    try {
      configureDashboardDb(dbPath);
      const live = upsertSession({
        id: "sess-1",
        title: "First title",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      expect(live).not.toHaveProperty("sessionFile");
      expect(getSessionDashboard().recentSessions).toEqual([]);
      expect(getSessionDashboard().sessions).toHaveLength(1);
      expect(listRecentSessions()).toEqual([]);

      setNowForTests(() => t0 + SESSION_TTL_SECONDS * 1000);
      expect(getSession("sess-1")).toBeNull();
      const afterExpiry = getSessionDashboard();
      expect(afterExpiry.sessions).toEqual([]);
      expect(afterExpiry.recentSessions).toHaveLength(1);
      const recent = afterExpiry.recentSessions[0]!;
      expect(recent.id).not.toBe("sess-1");
      expect(recent.title).toBe("First title");
      expect(recent).not.toHaveProperty("sessionFile");
      expect(JSON.stringify(afterExpiry)).not.toContain(sessionFile);

      const privateRow = getResumeSession(recent.id);
      expect(privateRow?.sessionId).toBe("sess-1");
      expect(privateRow?.sessionFile).toBe(sessionFile);
      expect(privateRow?.group).toEqual(live.group);
      expect(privateRow?.worktree).toEqual(live.worktree);

      resetStoreForTests();
      configureDashboardDb(dbPath);
      const reloaded = getSessionDashboard();
      expect(reloaded.sessions).toEqual([]);
      expect(reloaded.recentSessions).toEqual([
        {
          id: recent.id,
          title: "First title",
          lastSeenAt: recent.lastSeenAt,
          group: live.group,
          worktree: live.worktree,
        },
      ]);
      expect(JSON.stringify(reloaded)).not.toContain(sessionFile);
      expect(getResumeSession(recent.id)?.sessionFile).toBe(sessionFile);
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("live heartbeat suppresses recent; deactivate reveals without deleting", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-resume-live-"));
    const dbPath = join(root, "dash.sqlite");
    const cwd = join(root, "proj");
    mkdirSync(cwd);
    const sessionFile = join(root, "live.jsonl");
    try {
      configureDashboardDb(dbPath);
      upsertSession({
        id: "live-1",
        title: "Live",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      expect(getSessionDashboard().recentSessions).toEqual([]);

      expect(deactivateSession("live-1")).toBe(true);
      const dash = getSessionDashboard();
      expect(dash.sessions).toEqual([]);
      expect(dash.recentSessions).toHaveLength(1);
      const resumeId = dash.recentSessions[0]!.id;
      expect(getResumeSession(resumeId)?.sessionId).toBe("live-1");

      setNowForTests(() => t0 + 1000);
      upsertSession({
        id: "live-1",
        title: "Live again",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      expect(getSessionDashboard().sessions).toHaveLength(1);
      expect(getSessionDashboard().recentSessions).toEqual([]);
      expect(getResumeSession(resumeId)?.title).toBe("Live again");
      expect(getResumeSession(resumeId)?.sessionFile).toBe(sessionFile);
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dirty lastSeen batches; no per-heartbeat DB write until flush", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-resume-batch-"));
    const dbPath = join(root, "dash.sqlite");
    const cwd = join(root, "proj");
    mkdirSync(cwd);
    const sessionFile = join(root, "batch.jsonl");
    try {
      configureDashboardDb(dbPath);
      setResumeLastSeenFlushMsForTests(60_000);
      const first = upsertSession({
        id: "batch-1",
        title: "Batch",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      deactivateSession("batch-1");
      const resumeId = getSessionDashboard().recentSessions[0]!.id;
      setNowForTests(() => t0 + 500);
      upsertSession({
        id: "batch-1",
        title: "Batch",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });

      const baseline = getResumeSession(resumeId)!.lastSeenAt;
      expect(baseline).toBe(first.lastSeenAt);

      setNowForTests(() => t0 + 5_000);
      const second = upsertSession({
        id: "batch-1",
        title: "Batch",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      expect(second.lastSeenAt).not.toBe(baseline);
      expect(getResumeSession(resumeId)!.lastSeenAt).toBe(baseline);

      expect(flushDirtyLastSeen()).toBe(1);
      expect(getResumeSession(resumeId)!.lastSeenAt).toBe(second.lastSeenAt);

      setNowForTests(() => t0 + 10_000);
      const third = upsertSession({
        id: "batch-1",
        title: "Batch",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      expect(getResumeSession(resumeId)!.lastSeenAt).toBe(second.lastSeenAt);
      flushDashboardDb();
      expect(getResumeSession(resumeId)!.lastSeenAt).toBe(third.lastSeenAt);
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("title change upserts identity immediately without waiting for flush", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-resume-title-"));
    const dbPath = join(root, "dash.sqlite");
    const cwd = join(root, "proj");
    mkdirSync(cwd);
    const sessionFile = join(root, "title.jsonl");
    try {
      configureDashboardDb(dbPath);
      setResumeLastSeenFlushMsForTests(60_000);
      upsertSession({
        id: "title-1",
        title: "Before",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      deactivateSession("title-1");
      const resumeId = getSessionDashboard().recentSessions[0]!.id;

      setNowForTests(() => t0 + 2_000);
      upsertSession({
        id: "title-1",
        title: "After",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      expect(getResumeSession(resumeId)?.title).toBe("After");
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recentSessions display is bounded and omits live ids", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-resume-bound-"));
    const dbPath = join(root, "dash.sqlite");
    const cwd = join(root, "proj");
    mkdirSync(cwd);
    try {
      configureDashboardDb(dbPath);
      const limit = RECENT_SESSIONS_DISPLAY_LIMIT;
      for (let i = 0; i < limit + 5; i++) {
        setNowForTests(() => t0 + i * 1000);
        upsertSession({
          id: `bound-${i}`,
          title: `T${i}`,
          cwd,
          startedAt: "2026-08-12T00:00:00.000Z",
          sessionFile: join(root, `bound-${i}.jsonl`),
        });
        deactivateSession(`bound-${i}`);
      }
      const recents = getSessionDashboard().recentSessions;
      expect(recents).toHaveLength(limit);
      expect(recents[0]!.title).toBe(`T${limit + 4}`);
      expect(recents[limit - 1]!.title).toBe(`T${5}`);

      setNowForTests(() => t0 + 100_000);
      upsertSession({
        id: "bound-live",
        title: "Live newest",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile: join(root, "bound-live.jsonl"),
      });
      const withLive = getSessionDashboard();
      expect(withLive.sessions.map((s) => s.id)).toEqual(["bound-live"]);
      expect(withLive.recentSessions.some((r) => r.title === "Live newest")).toBe(
        false,
      );
      expect(withLive.recentSessions).toHaveLength(limit);
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("location removal cascades resume rows", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-resume-cascade-"));
    const dbPath = join(root, "dash.sqlite");
    const cwd = join(root, "proj");
    mkdirSync(cwd);
    const sessionFile = join(root, "cascade.jsonl");
    try {
      configureDashboardDb(dbPath);
      const live = upsertSession({
        id: "cascade-1",
        title: "Cascade",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile,
      });
      deactivateSession("cascade-1");
      const resumeId = getSessionDashboard().recentSessions[0]!.id;
      expect(getResumeSession(resumeId)).not.toBeNull();

      expect(
        removeDashboardLocation(live.group.path, live.worktree.path),
      ).toBe(true);
      expect(getSessionDashboard().locations).toEqual([]);
      expect(getSessionDashboard().recentSessions).toEqual([]);
      expect(getResumeSession(resumeId)).toBeNull();
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleteResumeSession removes one row and notifies", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-resume-del-"));
    const dbPath = join(root, "dash.sqlite");
    const cwd = join(root, "proj");
    mkdirSync(cwd);
    try {
      configureDashboardDb(dbPath);
      upsertSession({
        id: "del-1",
        title: "Del",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
        sessionFile: join(root, "del.jsonl"),
      });
      deactivateSession("del-1");
      const resumeId = getSessionDashboard().recentSessions[0]!.id;

      let emits = 0;
      const unsub = subscribeSessionChanges(() => {
        emits += 1;
      });
      expect(deleteResumeSession(resumeId)).toBe(true);
      expect(getResumeSession(resumeId)).toBeNull();
      expect(getSessionDashboard().recentSessions).toEqual([]);
      expect(emits).toBe(1);
      expect(deleteResumeSession(resumeId)).toBe(false);
      unsub();
    } finally {
      resetStoreForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("exclusiveSessionPid", () => {
  test("returns pid only when no other live session shares it", () => {
    upsertSession({
      id: "s1",
      title: "one",
      cwd: "/tmp/a",
      startedAt: "2026-08-12T00:00:00.000Z",
      pid: 4242,
    });
    expect(exclusiveSessionPid("s1")).toBe(4242);

    upsertSession({
      id: "s2",
      title: "two",
      cwd: "/tmp/b",
      startedAt: "2026-08-12T00:00:00.000Z",
      pid: 4242,
    });
    expect(exclusiveSessionPid("s1")).toBeUndefined();
    expect(exclusiveSessionPid("s2")).toBeUndefined();

    deactivateSession("s2");
    expect(exclusiveSessionPid("s1")).toBe(4242);
    expect(listSessions()[0]).not.toHaveProperty("pid");
  });

  test("missing pid is not killable", () => {
    upsertSession({
      id: "s1",
      title: "one",
      cwd: "/tmp/a",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(exclusiveSessionPid("s1")).toBeUndefined();
  });
});

describe("consumeLoginAttempt", () => {
  test("allows up to max then blocks until window resets", () => {
    for (let i = 0; i < LOGIN_ATTEMPT_MAX; i++) {
      expect(consumeLoginAttempt()).toBe(true);
    }
    expect(consumeLoginAttempt()).toBe(false);

    setNowForTests(() => t0 + 60_000);
    expect(consumeLoginAttempt()).toBe(true);
  });
});

describe("subscribeSessionChanges", () => {
  test("upsert emits; unsubscribe stops further emits", () => {
    const seen: string[][] = [];
    const unsub = subscribeSessionChanges((sessions) => {
      seen.push(sessions.map((s) => s.id));
    });

    upsertSession({
      id: "s1",
      title: "one",
      cwd: "/tmp/a",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(seen).toEqual([["s1"]]);

    upsertSession({
      id: "s1",
      title: "two",
      cwd: "/tmp/a",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(seen).toEqual([["s1"], ["s1"]]);

    unsub();
    const afterUnsub = seen.length;
    upsertSession({
      id: "s2",
      title: "other",
      cwd: "/tmp/b",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(seen).toHaveLength(afterUnsub);
  });

  test("location discovery batch persists and emits once", () => {
    let emits = 0;
    const unsub = subscribeSessionChanges(() => {
      emits++;
    });
    const changed = registerDashboardLocations([
      {
        group: { kind: "repository", name: "repo", path: "/tmp/repo" },
        worktree: { name: "main", path: "/tmp/repo" },
        lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
      },
      {
        group: { kind: "repository", name: "repo", path: "/tmp/repo" },
        worktree: { name: "feature", path: "/tmp/repo-feature" },
        lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
      },
    ]);

    expect(changed).toBe(2);
    expect(emits).toBe(1);
    expect(getSessionDashboard().locations).toHaveLength(2);
    unsub();
  });

  test("pure lastSeenAt heartbeat does not emit", () => {
    const calls: number[] = [];
    const unsub = subscribeSessionChanges(() => {
      calls.push(1);
    });
    upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(calls).toHaveLength(1);

    setNowForTests(() => t0 + 1000);
    upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    unsub();
  });

  test("expiry noticed on read emits without real timers", () => {
    const snapshots: number[] = [];
    const unsub = subscribeSessionChanges((sessions) => {
      snapshots.push(sessions.length);
    });
    upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(snapshots.at(-1)).toBe(1);

    setNowForTests(() => t0 + SESSION_TTL_SECONDS * 1000);
    expect(getSession("s1")).toBeNull();
    expect(snapshots.at(-1)).toBe(0);
    unsub();
  });

  test("listener errors do not break subsequent notifies", () => {
    let good = 0;
    const bad: SessionChangeListener = () => {
      throw new Error("boom");
    };
    const unsubBad = subscribeSessionChanges(bad);
    const unsubGood = subscribeSessionChanges(() => {
      good += 1;
    });
    expect(() =>
      upsertSession({
        id: "s1",
        title: "t",
        cwd: "/tmp",
        startedAt: "2026-08-12T00:00:00.000Z",
      }),
    ).not.toThrow();
    expect(good).toBe(1);
    unsubBad();
    unsubGood();
  });
});
