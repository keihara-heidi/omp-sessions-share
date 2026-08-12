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
    upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(getSession("s1")).not.toBeNull();
    expect(listSessions()).toHaveLength(1);

    setNowForTests(() => t0 + SESSION_TTL_SECONDS * 1000);
    expect(getSession("s1")).toBeNull();
    expect(listSessions()).toEqual([]);
  });

  test("heartbeat refreshes session TTL", () => {
    upsertSession({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    setNowForTests(() => t0 + (SESSION_TTL_SECONDS - 1) * 1000);
    upsertSession({
      id: "s1",
      title: "t2",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    setNowForTests(() => t0 + (SESSION_TTL_SECONDS + 5) * 1000);
    expect(getSession("s1")).toMatchObject({ title: "t2" });
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
