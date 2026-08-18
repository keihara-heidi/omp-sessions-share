import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShareConfig } from "../shared/config";
import {
  handleApi,
  resetDashboardReconciliationForTests,
} from "../daemon/api";
import { DASHBOARD_COOKIE_NAME } from "../lib/auth";
import {
  parseRecentSessionSummary,
  parseSessionSummary,
  type RecentSessionSummary,
  type SessionDashboard,
  type SessionSummary,
} from "../lib/contracts";
import {
  configureDashboardDb,
  deactivateSession,
  getResumeSession,
  resetStoreForTests,
  upsertSession,
} from "../daemon/store";

const config: ShareConfig = {
  version: 1,
  localOrigin: "http://127.0.0.1:7466",
  publicOrigin: "https://host.example.ts.net:8443",
  hostToken: "host-token-long-enough",
  dashboardPassword: "dashboard-password",
  cookieSecret: "cookie-secret-long-enough",
};

const PRIVATE_MARKERS = [
  "sessionFile",
  "session_file",
  "sessionId",
  "session_id",
  "resumeId",
  "resume_id",
  "resumeSessionFile",
] as const;

const tempRoots: string[] = [];

beforeEach(() => {
  resetStoreForTests();
  resetDashboardReconciliationForTests();
});

afterEach(() => {
  resetStoreForTests();
  resetDashboardReconciliationForTests();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function jsonRequest(
  url: string,
  body: unknown,
  headers?: HeadersInit,
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function api(
  req: Request,
  pathname = new URL(req.url).pathname,
): Promise<Response> {
  const res = await handleApi(req, config, pathname);
  if (!res) throw new Error(`no handler for ${pathname}`);
  return res;
}

async function loginCookie(
  password = config.dashboardPassword,
): Promise<string> {
  const res = await api(
    jsonRequest("http://local/api/auth/login", { password }),
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const cookie = setCookie!.split(";", 1)[0]!;
  expect(cookie.startsWith(`${DASHBOARD_COOKIE_NAME}=`)).toBe(true);
  return cookie;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value, done } = await reader.read();
  if (done || !value) return "";
  return new TextDecoder().decode(value);
}

function assertNoPrivateLeak(serialized: string, sessionFile: string): void {
  expect(serialized).not.toContain(sessionFile);
  expect(serialized).not.toContain(".jsonl");
  for (const marker of PRIVATE_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

function assertPublicRecent(row: unknown): RecentSessionSummary {
  const parsed = parseRecentSessionSummary(row);
  expect(parsed).not.toBeNull();
  const recent = parsed!;
  expect(recent).toEqual({
    id: recent.id,
    title: recent.title,
    lastSeenAt: recent.lastSeenAt,
    origin: recent.origin,
    group: recent.group,
    worktree: recent.worktree,
  });
  expect(Object.keys(recent).sort()).toEqual([
    "group",
    "id",
    "lastSeenAt",
    "origin",
    "title",
    "worktree",
  ]);
  return recent;
}

function assertPublicLive(row: unknown): SessionSummary {
  const parsed = parseSessionSummary(row);
  expect(parsed).not.toBeNull();
  const session = parsed!;
  expect(Object.keys(session).sort()).toEqual([
    "cwd",
    "group",
    "id",
    "lastSeenAt",
    "origin",
    "startedAt",
    "title",
    "worktree",
  ]);
  return session;
}

function openTempDashboard(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-public-contract-"));
  tempRoots.push(root);
  configureDashboardDb(join(root, "dashboard.sqlite"));
  return root;
}

describe("INT-01 recent public contract", () => {
  test("authenticated dashboard, SSE, and resume never expose private resume fields", async () => {
    const root = openTempDashboard();
    const cwd = mkdtempSync(join(root, "wt-"));
    mkdirSync(join(root, "private-host-only", "sessions"), { recursive: true });
    const sessionFile = join(
      root,
      "private-host-only",
      "sessions",
      "secret-resume-token.jsonl",
    );
    writeFileSync(sessionFile, '{"type":"session"}\n{"type":"message"}\n');

    const sessionId = "host_session_private_1";
    const title = "Remembered public title";
    const live = upsertSession({
      id: sessionId,
      title,
      cwd,
      startedAt: "2026-08-12T00:00:00.000Z",
      sessionFile,
    });

    const cookie = await loginCookie();

    // Live dashboard snapshot must not carry host-only sessionFile.
    {
      const res = await api(
        new Request("http://local/api/dashboard", { headers: { cookie } }),
      );
      expect(res.status).toBe(200);
      const raw = await res.text();
      assertNoPrivateLeak(raw, sessionFile);
      const body = JSON.parse(raw) as { data: SessionDashboard };
      expect(body.data.sessions).toHaveLength(1);
      const publicLive = assertPublicLive(body.data.sessions[0]);
      expect(publicLive.id).toBe(sessionId);
      expect(publicLive.title).toBe(title);
      expect(body.data.recentSessions).toEqual([]);
    }

    expect(deactivateSession(sessionId)).toBe(true);

    // Recent dashboard snapshot: opaque resume id + public Recent shape only.
    let resumeId = "";
    {
      const res = await api(
        new Request("http://local/api/dashboard", { headers: { cookie } }),
      );
      expect(res.status).toBe(200);
      const raw = await res.text();
      assertNoPrivateLeak(raw, sessionFile);
      const body = JSON.parse(raw) as { data: SessionDashboard };
      expect(body.data.sessions).toEqual([]);
      expect(body.data.recentSessions).toHaveLength(1);
      const recent = assertPublicRecent(body.data.recentSessions[0]);
      resumeId = recent.id;
      expect(resumeId).not.toBe(sessionId);
      expect(recent.title).toBe(title);
      expect(recent.worktree.path).toBe(live.worktree.path);

      // Host-only row still holds exact JSONL path privately.
      const privateRow = getResumeSession(resumeId);
      expect(privateRow?.sessionId).toBe(sessionId);
      expect(privateRow?.sessionFile).toBe(sessionFile);
    }

    // SSE initial snapshot uses the same public dashboard contract.
    {
      const ac = new AbortController();
      const res = await api(
        new Request("http://local/api/events", {
          method: "GET",
          headers: { cookie, accept: "text/event-stream" },
          signal: ac.signal,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain(
        "text/event-stream",
      );

      const reader = res.body!.getReader();
      const chunk = await readChunk(reader);
      expect(chunk).toContain("event: dashboard\n");
      const dataLine = chunk
        .split("\n")
        .find((line) => line.startsWith("data: "));
      expect(dataLine).toBeTruthy();
      const payloadRaw = dataLine!.slice("data: ".length);
      assertNoPrivateLeak(payloadRaw, sessionFile);
      assertNoPrivateLeak(chunk, sessionFile);

      const payload = JSON.parse(payloadRaw) as { data: SessionDashboard };
      expect(payload.data.sessions).toEqual([]);
      expect(payload.data.recentSessions).toHaveLength(1);
      const recent = assertPublicRecent(payload.data.recentSessions[0]);
      expect(recent.id).toBe(resumeId);
      expect(recent.title).toBe(title);

      ac.abort();
    }

    // Cookie-only empty-body resume responds with public ok only.
    {
      const path = `/api/recent-sessions/${resumeId}/resume`;
      const launches: Array<{ path: string; init?: unknown }> = [];
      const res = await handleApi(
        new Request(`http://local${path}`, {
          method: "POST",
          headers: { cookie },
        }),
        config,
        path,
        async (worktreePath, init) => {
          launches.push({ path: worktreePath, init });
        },
      );
      expect(res?.status).toBe(200);
      const raw = await res!.text();
      assertNoPrivateLeak(raw, sessionFile);
      expect(JSON.parse(raw)).toEqual({ data: { ok: true } });
      expect(launches).toEqual([
        {
          path: live.worktree.path,
          init: { resumeSessionFile: sessionFile },
        },
      ]);
    }
  });
});
