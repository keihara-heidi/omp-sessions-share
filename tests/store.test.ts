import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUEST_TTL_SECONDS,
  SESSION_TTL_SECONDS,
} from "../lib/contracts";
import {
  LOGIN_ATTEMPT_MAX,
  configureDashboardLocationPersistence,
  consumeLoginAttempt,
  createRequest,
  deactivateSession,
  exclusiveSessionPid,
  getRequest,
  getSession,
  getSessionDashboard,
  listRequestsBySession,
  listSessions,
  registerDashboardLocations,
  removeDashboardLocation,
  resetStoreForTests,
  setNowForTests,
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
    });
  });

  test("dashboard locations survive daemon store reloads until explicitly removed", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-location-history-"));
    const cwd = join(root, "project");
    const historyPath = join(root, "locations.json");
    mkdirSync(cwd);
    try {
      configureDashboardLocationPersistence(historyPath);
      const session = upsertSession({
        id: "persisted-session",
        title: "Persistent",
        cwd,
        startedAt: "2026-08-12T00:00:00.000Z",
      });

      resetStoreForTests();
      configureDashboardLocationPersistence(historyPath);
      expect(getSessionDashboard()).toMatchObject({
        sessions: [],
        locations: [
          {
            group: session.group,
            worktree: session.worktree,
            lastSessionStartedAt: session.startedAt,
          },
        ],
      });

      expect(
        removeDashboardLocation(session.group.path, session.worktree.path),
      ).toBe(true);
      resetStoreForTests();
      configureDashboardLocationPersistence(historyPath);
      expect(getSessionDashboard().locations).toEqual([]);
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

    // Keep session alive past request TTL.
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

    // Title change is meaningful → emit
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
