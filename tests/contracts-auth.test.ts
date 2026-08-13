import { describe, expect, test } from "bun:test";
import {
  isEncryptedLink,
  isValidId,
  isValidPublicKeyJwk,
  parseCreateJoinRequestInput,
  parseCreateWorktreeInput,
  parseHostSessionHeartbeat,
  parseRequestDecision,
  parseSessionWorktree,
  parseSessionGroup,
  parseSessionSummary,
  type SessionSummary,
  readJsonBody,
} from "../lib/contracts";
import {
  DASHBOARD_COOKIE_NAME,
  clearSessionCookie,
  createSessionCookie,
  signSessionCookie,
  timingSafeEqual,
  verifySessionCookie,
} from "../lib/auth";
import {
  issueDashboardCookie,
  requireHostAuth,
  verifyPassword,
} from "../daemon/auth";
import type { ShareConfig } from "../shared/config";

const pubJwk = {
  kty: "RSA",
  alg: "RSA-OAEP-256",
  use: "enc",
  key_ops: ["encrypt"],
  n: "x".repeat(342),
  e: "AQAB",
};
const ciphertext = "x".repeat(342);

const config: ShareConfig = {
  version: 1,
  localOrigin: "http://127.0.0.1:7466",
  publicOrigin: "https://host.example.ts.net:8443",
  hostToken: "host-token-long-enough",
  dashboardPassword: "dashboard-password",
  cookieSecret: "cookie-secret-long-enough",
};

describe("contracts validators", () => {
  test("rejects invalid ids", () => {
    expect(isValidId("ok_1-2")).toBe(true);
    expect(isValidId("")).toBe(false);
    expect(isValidId("has space")).toBe(false);
    expect(isValidId("a".repeat(129))).toBe(false);
  });

  test("rejects private JWKs and bad shapes", () => {
    expect(isValidPublicKeyJwk(pubJwk)).toBe(true);
    expect(isValidPublicKeyJwk({ ...pubJwk, d: "secret" })).toBe(false);
    expect(isValidPublicKeyJwk({ ...pubJwk, kty: "EC" })).toBe(false);
    expect(isValidPublicKeyJwk({ ...pubJwk, alg: "RS256" })).toBe(false);
    expect(isValidPublicKeyJwk({ ...pubJwk, use: "sig" })).toBe(false);
    expect(isValidPublicKeyJwk({ ...pubJwk, key_ops: ["decrypt"] })).toBe(false);
  });

  test("parses heartbeat / session / create / decision bodies", () => {
    expect(
      parseHostSessionHeartbeat({
        id: "s1",
        title: "t",
        cwd: "/tmp",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      parseHostSessionHeartbeat({
        id: "s1",
        title: "t",
        cwd: "/tmp",
        startedAt: "2026-01-01T00:00:00.000Z",
        pid: 4242,
      }),
    ).toEqual({
      id: "s1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-01-01T00:00:00.000Z",
      pid: 4242,
    });
    expect(
      parseHostSessionHeartbeat({
        id: "s1",
        title: "t",
        cwd: "/tmp",
        startedAt: "2026-01-01T00:00:00.000Z",
        pid: 1,
      })?.pid,
    ).toBeUndefined();
    expect(
      parseHostSessionHeartbeat({
        id: "s1",
        cwd: "/tmp",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBeNull();

    const validSummary: SessionSummary = {
      id: "s1",
      title: "t",
      cwd: "/tmp/project",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
      group: {
        kind: "repository",
        name: "project",
        path: "/tmp/project",
      },
      worktree: { name: "project", path: "/tmp/project" },
    };
    expect(parseSessionSummary(validSummary)).toEqual(validSummary);
    expect(
      parseSessionWorktree({ name: "wt", path: "/tmp/wt", branch: "feat/x" }),
    ).toEqual({ name: "wt", path: "/tmp/wt", branch: "feat/x" });
    expect(parseSessionWorktree({ name: "wt", path: "/tmp/wt", branch: "" })).toBeNull();

    // Missing nested metadata is invalid
    expect(
      parseSessionSummary({
        id: "s1",
        title: "t",
        cwd: "/tmp",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:01.000Z",
      }),
    ).toBeNull();

    expect(
      parseCreateJoinRequestInput({ deviceName: "phone", publicKeyJwk: pubJwk }),
    ).not.toBeNull();
    expect(parseCreateWorktreeInput({ groupPath: "/tmp/repo" })).toEqual({
      groupPath: "/tmp/repo",
    });
    expect(parseCreateWorktreeInput({ groupPath: "" })).toBeNull();
    expect(
      parseCreateJoinRequestInput({
        deviceName: "phone",
        publicKeyJwk: { ...pubJwk, d: "x" },
      }),
    ).toBeNull();
    expect(
      parseRequestDecision({
        sessionId: "s1",
        status: "approved",
        encryptedLink: { algorithm: "RSA-OAEP-256", ciphertext },
      }),
    ).not.toBeNull();
    expect(
      parseRequestDecision({
        sessionId: "s1",
        status: "denied",
        encryptedLink: { algorithm: "RSA-OAEP-256", ciphertext },
      }),
    ).toBeNull();
    expect(isEncryptedLink({ algorithm: "RSA-OAEP-256", ciphertext })).toBe(true);
    expect(isEncryptedLink({ algorithm: "none", ciphertext })).toBe(false);
  });

  test("parseSessionGroup and parseSessionWorktree valid/invalid", () => {
    expect(
      parseSessionGroup({
        kind: "repository",
        name: "omp",
        path: "/Users/dev/omp",
      }),
    ).toEqual({
      kind: "repository",
      name: "omp",
      path: "/Users/dev/omp",
    });
    expect(
      parseSessionGroup({ kind: "folder", name: "scratch", path: "/tmp/scratch" }),
    ).toEqual({ kind: "folder", name: "scratch", path: "/tmp/scratch" });
    expect(
      parseSessionGroup({ kind: "other", name: "x", path: "/x" }),
    ).toBeNull();
    expect(parseSessionGroup({ kind: "repository", name: "", path: "/x" })).toBeNull();
    expect(
      parseSessionGroup({ kind: "repository", name: "x", path: "" }),
    ).toBeNull();
    expect(parseSessionGroup(null)).toBeNull();

    expect(parseSessionWorktree({ name: "main", path: "/repo" })).toEqual({
      name: "main",
      path: "/repo",
    });
    expect(parseSessionWorktree({ name: "", path: "/repo" })).toBeNull();
    expect(parseSessionWorktree({ name: "main", path: "" })).toBeNull();
    expect(parseSessionWorktree({ path: "/repo" })).toBeNull();
  });

  test("parseSessionSummary rejects bad nested group/worktree", () => {
    const base = {
      id: "s1",
      title: "t",
      cwd: "/tmp/project",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
    };
    expect(
      parseSessionSummary({
        ...base,
        group: { kind: "repository", name: "project", path: "/tmp/project" },
        worktree: { name: "", path: "/tmp/project" },
      }),
    ).toBeNull();
    expect(
      parseSessionSummary({
        ...base,
        group: { kind: "nope", name: "project", path: "/tmp/project" },
        worktree: { name: "project", path: "/tmp/project" },
      }),
    ).toBeNull();
    expect(
      parseSessionSummary({
        ...base,
        group: { kind: "folder", name: "project", path: "/tmp/project" },
        // worktree missing
      }),
    ).toBeNull();

    const folderOk = {
      ...base,
      group: { kind: "folder" as const, name: "project", path: "/tmp/project" },
      worktree: { name: "project", path: "/tmp/project" },
    };
    expect(parseSessionSummary(folderOk)).toEqual(folderOk);

    // id stability for mobile open: parser must not rewrite id
    const parsed = parseSessionSummary({
      ...folderOk,
      id: "mobile-stable-id_1",
    });
    expect(parsed?.id).toBe("mobile-stable-id_1");
  });

  test("bounds JSON request bodies at 16KiB default", async () => {
    const valid = await readJsonBody(
      new Request("http://local", { method: "POST", body: '{"ok":true}' }),
    );
    expect(valid).toEqual({ ok: true, value: { ok: true } });
    const oversized = await readJsonBody(
      new Request("http://local", {
        method: "POST",
        body: `"${"x".repeat(20_000)}"`,
      }),
    );
    expect(oversized).toEqual({ ok: false, error: "Request body too large" });
  });
});

describe("auth cookie hmac", () => {
  test("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });

  test("signs and verifies cookie expiry", async () => {
    const secret = "test-cookie-secret-value";
    const value = await signSessionCookie(60, secret);
    expect(await verifySessionCookie(value, secret)).toBe(true);
    expect(await verifySessionCookie(value + "x", secret)).toBe(false);
    expect(await verifySessionCookie(value, "other")).toBe(false);
    const header = createSessionCookie(value, { maxAge: 60, secure: false });
    expect(header.startsWith(`${DASHBOARD_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(clearSessionCookie({ secure: false })).toContain("Max-Age=0");
  });
});


describe("daemon auth helpers", () => {
  test("verifyPassword and host Bearer against config", () => {
    expect(verifyPassword(config.dashboardPassword, config)).toBe(true);
    expect(verifyPassword("wrong-password!!!!", config)).toBe(false);
    expect(
      requireHostAuth(
        new Request("http://local", {
          headers: { authorization: `Bearer ${config.hostToken}` },
        }),
        config,
      ),
    ).toEqual({ ok: true });
    expect(
      requireHostAuth(
        new Request("http://local", {
          headers: { authorization: "Bearer nope" },
        }),
        config,
      ),
    ).toBeInstanceOf(Response);
  });

  test("issueDashboardCookie is Secure and verifies as local host", async () => {
    const header = await issueDashboardCookie(config);
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    const raw = header.split(";", 1)[0]!.slice(`${DASHBOARD_COOKIE_NAME}=`.length);
    expect(await verifySessionCookie(raw, config.cookieSecret)).toBe(true);
  });
});
