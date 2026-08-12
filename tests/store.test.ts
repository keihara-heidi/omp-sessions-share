import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  REQUEST_TTL_SECONDS,
  SESSION_TTL_SECONDS,
} from "../lib/contracts";
import {
  LOGIN_ATTEMPT_MAX,
  consumeLoginAttempt,
  createRequest,
  getRequest,
  getSession,
  listRequestsBySession,
  listSessions,
  resetStoreForTests,
  setNowForTests,
  upsertSession,
} from "../daemon/store";

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
