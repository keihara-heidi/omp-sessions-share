import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShareConfig } from "../shared/config";
import { handleApi } from "../daemon/api";
import { DASHBOARD_COOKIE_NAME } from "../lib/auth";
import {
  deactivateSession,
  getSessionDashboard,
  listSessions,
  resetStoreForTests,
  upsertSession,
} from "../daemon/store";
import { createGitWorktree } from "../daemon/git-worktree";

const config: ShareConfig = {
  version: 1,
  localOrigin: "http://127.0.0.1:7466",
  publicOrigin: "https://host.example.ts.net:8443",
  hostToken: "host-token-long-enough",
  dashboardPassword: "dashboard-password",
  cookieSecret: "cookie-secret-long-enough",
};

const hostHeaders = {
  authorization: `Bearer ${config.hostToken}`,
  "content-type": "application/json",
};

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
}

function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-api-wt-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "test"]);
  writeFileSync(join(dir, "README"), "init\n");
  runGit(dir, ["add", "README"]);
  runGit(dir, ["commit", "-m", "init"]);
  return dir;
}

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

async function loginCookie(password = config.dashboardPassword): Promise<string> {
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

async function rsaPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
}

beforeEach(() => resetStoreForTests());
afterEach(() => resetStoreForTests());

describe("local daemon auth gates", () => {
  test("password cookie login and reject bad password", async () => {
    expect(
      (
        await api(
          new Request("http://local/api/sessions", { method: "GET" }),
        )
      ).status,
    ).toBe(401);

    const bad = await api(
      jsonRequest("http://local/api/auth/login", { password: "nope-nope-nope" }),
    );
    expect(bad.status).toBe(401);

    const cookie = await loginCookie();
    const meta = await api(
      new Request("http://local/api/meta", {
        headers: { cookie },
      }),
    );
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual({
      data: { publicOrigin: config.publicOrigin },
    });
  });

  test("Bearer host heartbeat required", async () => {
    const body = {
      id: "session_1",
      title: "t",
      cwd: "/tmp",
      startedAt: "2026-08-12T00:00:00.000Z",
    };
    expect(
      (await api(jsonRequest("http://local/api/host/sessions", body))).status,
    ).toBe(401);
    expect(
      (
        await api(
          jsonRequest("http://local/api/host/sessions", body, {
            authorization: "Bearer wrong-token-value!!",
          }),
        )
      ).status,
    ).toBe(401);

    const ok = await api(
      jsonRequest("http://local/api/host/sessions", body, hostHeaders),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      data: { id: "session_1", title: "t" },
    });
  });

  test("starts OMP in a remembered worktree with no live sessions", async () => {
    const session = upsertSession({
      id: "launch_source",
      title: "Existing session",
      cwd: "/tmp/phone-launch",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const body = { worktreePath: session.worktree.path };

    const unauthorized = await api(
      jsonRequest("http://local/api/sessions/launch", body),
    );
    expect(unauthorized.status).toBe(401);
    expect(deactivateSession(session.id)).toBe(true);
    expect(listSessions()).toEqual([]);

    const cookie = await loginCookie();
    const launchedPaths: string[] = [];
    const launched = await handleApi(
      jsonRequest("http://local/api/sessions/launch", body, { cookie }),
      config,
      "/api/sessions/launch",
      async (worktreePath) => {
        launchedPaths.push(worktreePath);
      },
    );
    expect(launched?.status).toBe(200);
    expect(await launched?.json()).toEqual({ data: { ok: true } });
    expect(launchedPaths).toEqual([session.worktree.path]);

    const unknown = await handleApi(
      jsonRequest(
        "http://local/api/sessions/launch",
        { worktreePath: "/tmp/not-advertised" },
        { cookie },
      ),
      config,
      "/api/sessions/launch",
      async () => {
        throw new Error("must not launch");
      },
    );
    expect(unknown?.status).toBe(404);
  });

  test("creates a blank worktree for a remembered repository with no sessions", async () => {
    const repo = initGitRepo();
    try {
      const session = upsertSession({
        id: "create_source",
        title: "Existing session",
        cwd: repo,
        startedAt: "2026-08-12T00:00:00.000Z",
      });
      const body = { groupPath: session.group.path };

      const unauthorized = await api(
        jsonRequest("http://local/api/sessions/worktrees", body),
      );
      expect(unauthorized.status).toBe(401);
      expect(deactivateSession(session.id)).toBe(true);
      expect(listSessions()).toEqual([]);

      const cookie = await loginCookie();
      const createdFor: string[][] = [];
      const launchedPaths: string[] = [];
      const created = await handleApi(
        jsonRequest("http://local/api/sessions/worktrees", body, { cookie }),
        config,
        "/api/sessions/worktrees",
        async (worktreePath) => {
          launchedPaths.push(worktreePath);
        },
        async (advertisedPaths) => {
          createdFor.push(advertisedPaths);
          return { path: "/tmp/new-worktree" };
        },
      );
      expect(created?.status).toBe(200);
      expect(await created?.json()).toEqual({
        data: { ok: true, path: "/tmp/new-worktree" },
      });
      expect(createdFor).toEqual([[session.group.path]]);
      expect(launchedPaths).toEqual(["/tmp/new-worktree"]);

      const unknown = await handleApi(
        jsonRequest(
          "http://local/api/sessions/worktrees",
          { groupPath: "/tmp/not-advertised" },
          { cookie },
        ),
        config,
        "/api/sessions/worktrees",
        async () => {
          throw new Error("must not launch");
        },
        async () => {
          throw new Error("must not create");
        },
      );
      expect(unknown?.status).toBe(404);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("prunes a worktree deleted outside the dashboard", async () => {
    const repo = initGitRepo();
    const linked = await createGitWorktree([repo]);
    try {
      const session = upsertSession({
        id: "externally_deleted_worktree",
        title: "Deleted outside dashboard",
        cwd: linked.path,
        startedAt: "2026-08-12T00:00:00.000Z",
      });
      expect(getSessionDashboard().locations).toHaveLength(1);
      rmSync(linked.path, { recursive: true, force: true });

      const cookie = await loginCookie();
      const res = await api(
        new Request("http://local/api/dashboard", { headers: { cookie } }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { sessions: [], locations: [] },
      });
      expect(listSessions()).toEqual([]);
      expect(getSessionDashboard().locations).toEqual([]);
      expect(session.worktree.path).toBe(linked.path);
    } finally {
      rmSync(linked.path, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("prunes a folder deleted outside the dashboard", async () => {
    const folder = mkdtempSync(join(tmpdir(), "omp-api-folder-"));
    upsertSession({
      id: "externally_deleted_folder",
      title: "Deleted folder",
      cwd: folder,
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    rmSync(folder, { recursive: true, force: true });

    const cookie = await loginCookie();
    const res = await api(
      new Request("http://local/api/dashboard", { headers: { cookie } }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { sessions: [], locations: [] },
    });
  });

  test("deletes a remembered linked worktree with no live sessions", async () => {
    const repo = initGitRepo();
    const linked = await createGitWorktree([repo]);
    try {
      const session = upsertSession({
        id: "delete_source",
        title: "Delete worktree",
        cwd: linked.path,
        startedAt: "2026-08-12T00:00:00.000Z",
      });
      expect(deactivateSession(session.id)).toBe(true);
      const cookie = await loginCookie();
      const removed: Array<[string, string]> = [];
      const res = await handleApi(
        new Request("http://local/api/sessions/worktrees", {
          method: "DELETE",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            groupPath: session.group.path,
            worktreePath: session.worktree.path,
          }),
        }),
        config,
        "/api/sessions/worktrees",
        undefined,
        undefined,
        {
          removeWorktree: async (repositoryPath, worktreePath) => {
            removed.push([repositoryPath, worktreePath]);
          },
        },
      );

      expect(res?.status).toBe(200);
      expect(await res?.json()).toEqual({ data: { ok: true } });
      expect(removed).toEqual([[session.group.path, session.worktree.path]]);
      expect(listSessions()).toEqual([]);
      expect(getSessionDashboard().locations).toEqual([]);
    } finally {
      rmSync(linked.path, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("refuses deletion when the worktree has uncommitted changes", async () => {
    const repo = initGitRepo();
    const linked = await createGitWorktree([repo]);
    try {
      const session = upsertSession({
        id: "dirty_delete_source",
        title: "Dirty worktree",
        cwd: linked.path,
        startedAt: "2026-08-12T00:00:00.000Z",
      });
      const cookie = await loginCookie();
      const res = await handleApi(
        new Request("http://local/api/sessions/worktrees", {
          method: "DELETE",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            groupPath: session.group.path,
            worktreePath: session.worktree.path,
          }),
        }),
        config,
        "/api/sessions/worktrees",
        undefined,
        undefined,
        {
          removeWorktree: async () => {
            throw new Error("Worktree has uncommitted changes");
          },
        },
      );

      expect(res?.status).toBe(409);
      expect(await res?.json()).toEqual({
        error: "Worktree has uncommitted changes",
      });
      expect(listSessions()).toHaveLength(1);
    } finally {
      rmSync(linked.path, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("returns 400 when worktree create is not a git repository", async () => {
    const folder = mkdtempSync(join(tmpdir(), "omp-api-nogit-"));
    try {
      const session = upsertSession({
        id: "nogit_source",
        title: "Folder session",
        cwd: folder,
        startedAt: "2026-08-12T00:00:00.000Z",
      });
      const cookie = await loginCookie();
      const res = await handleApi(
        jsonRequest(
          "http://local/api/sessions/worktrees",
          { groupPath: session.group.path },
          { cookie },
        ),
        config,
        "/api/sessions/worktrees",
        async () => {
          throw new Error("must not launch");
        },
        async () => {
          throw new Error("Not a git repository");
        },
      );
      expect(res?.status).toBe(400);
      expect(await res?.json()).toEqual({ error: "Not a git repository" });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("deactivates a session without allowing heartbeats to restore it", async () => {
    const heartbeatBody = {
      id: "session_inactive",
      title: "Remove me",
      cwd: "/tmp/inactive",
      startedAt: "2026-08-12T00:00:00.000Z",
    };
    await api(
      jsonRequest("http://local/api/host/sessions", heartbeatBody, hostHeaders),
    );

    const path = "/api/sessions/session_inactive/deactivate";
    expect((await api(new Request(`http://local${path}`, { method: "POST" }))).status).toBe(401);
    const cookie = await loginCookie();
    const removed = await api(
      new Request(`http://local${path}`, { method: "POST", headers: { cookie } }),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ data: { ok: true } });

    const repeatedHeartbeat = await api(
      jsonRequest("http://local/api/host/sessions", heartbeatBody, hostHeaders),
    );
    expect(await repeatedHeartbeat.json()).toEqual({ data: { inactive: true } });
    const sessions = await api(
      new Request("http://local/api/sessions", { headers: { cookie } }),
    );
    expect(await sessions.json()).toEqual({ data: [] });

    const requests = await api(
      new Request("http://local/api/host/requests?sessionId=session_inactive", {
        headers: { authorization: `Bearer ${config.hostToken}` },
      }),
    );
    expect(requests.status).toBe(200);
    expect(await requests.json()).toEqual({ data: [] });
  });
});

describe("approved session link flow", () => {
  test("password cookie, Bearer heartbeat, create/poll/approve RSA ciphertext", async () => {
    const cookie = await loginCookie();
    const sessionId = "session_1";

    const heartbeat = await api(
      jsonRequest(
        "http://local/api/host/sessions",
        {
          id: sessionId,
          title: "Approval flow",
          cwd: "/tmp/project",
          startedAt: "2026-08-12T00:00:00.000Z",
        },
        hostHeaders,
      ),
    );
    expect(heartbeat.status).toBe(200);

    const sessions = await api(
      new Request("http://local/api/sessions", { headers: { cookie } }),
    );
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toMatchObject({
      data: [{ id: sessionId, title: "Approval flow" }],
    });

    const keyPair = await rsaPair();
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

    const create = await api(
      jsonRequest(
        `http://local/api/sessions/${sessionId}/requests`,
        { deviceName: "Test phone", publicKeyJwk },
        { cookie },
      ),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      data: { id: string; status: string; publicKeyJwk: JsonWebKey };
    };
    expect(created.data.status).toBe("pending");
    expect(created.data).not.toHaveProperty("encryptedLink");

    const pendingRes = await api(
      new Request(`http://local/api/host/requests?sessionId=${sessionId}`, {
        headers: { authorization: `Bearer ${config.hostToken}` },
      }),
    );
    expect(pendingRes.status).toBe(200);
    const pending = (await pendingRes.json()) as {
      data: Array<{ id: string; publicKeyJwk: JsonWebKey; status: string }>;
    };
    expect(pending.data).toHaveLength(1);
    expect(pending.data[0]).toMatchObject({
      id: created.data.id,
      status: "pending",
    });
    expect(JSON.stringify(pending)).not.toContain("encryptedLink");
    expect(JSON.stringify(pending)).not.toContain("my.omp.sh");

    const collabLink = "https://my.omp.sh/#room.secret";
    const importedKey = await crypto.subtle.importKey(
      "jwk",
      pending.data[0]!.publicKeyJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      importedKey,
      new TextEncoder().encode(collabLink),
    );
    const ciphertext = Buffer.from(encrypted).toString("base64url");

    const decision = await api(
      jsonRequest(
        `http://local/api/host/requests/${created.data.id}`,
        {
          sessionId,
          status: "approved",
          encryptedLink: { algorithm: "RSA-OAEP-256", ciphertext },
        },
        hostHeaders,
      ),
    );
    expect(decision.status).toBe(200);
    const decidedBody = await decision.text();
    expect(decidedBody).not.toContain(collabLink);
    expect(decidedBody).not.toContain("room.secret");

    const poll = await api(
      new Request(`http://local/api/requests/${created.data.id}`, {
        headers: { cookie },
      }),
    );
    expect(poll.status).toBe(200);
    const result = (await poll.json()) as {
      data: {
        status: string;
        encryptedLink: { algorithm: string; ciphertext: string };
      };
    };
    expect(result.data.status).toBe("approved");
    expect(result.data.encryptedLink.algorithm).toBe("RSA-OAEP-256");
    expect(JSON.stringify(result)).not.toContain(collabLink);

    const plaintext = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      keyPair.privateKey,
      Buffer.from(result.data.encryptedLink.ciphertext, "base64url"),
    );
    expect(new TextDecoder().decode(plaintext)).toBe(collabLink);
  });

  test("cross-session decision mismatch returns 409", async () => {
    const cookie = await loginCookie();
    for (const id of ["session_a", "session_b"]) {
      const hb = await api(
        jsonRequest(
          "http://local/api/host/sessions",
          {
            id,
            title: id,
            cwd: "/tmp",
            startedAt: "2026-08-12T00:00:00.000Z",
          },
          hostHeaders,
        ),
      );
      expect(hb.status).toBe(200);
    }

    const keyPair = await rsaPair();
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const create = await api(
      jsonRequest(
        "http://local/api/sessions/session_a/requests",
        { deviceName: "phone", publicKeyJwk },
        { cookie },
      ),
    );
    const { data } = (await create.json()) as { data: { id: string } };

    const mismatch = await api(
      jsonRequest(
        `http://local/api/host/requests/${data.id}`,
        { sessionId: "session_b", status: "denied" },
        hostHeaders,
      ),
    );
    expect(mismatch.status).toBe(409);

    const deny = await api(
      jsonRequest(
        `http://local/api/host/requests/${data.id}`,
        { sessionId: "session_a", status: "denied" },
        hostHeaders,
      ),
    );
    expect(deny.status).toBe(200);
    const denied = (await deny.json()) as { data: { status: string } };
    expect(denied.data.status).toBe("denied");
    expect(denied.data).not.toHaveProperty("encryptedLink");
  });

  test("rejects oversize JSON bodies at 16KiB", async () => {
    const cookie = await loginCookie();
    await api(
      jsonRequest(
        "http://local/api/host/sessions",
        {
          id: "session_1",
          title: "t",
          cwd: "/tmp",
          startedAt: "2026-08-12T00:00:00.000Z",
        },
        hostHeaders,
      ),
    );

    const huge = "x".repeat(20_000);
    const res = await api(
      new Request("http://local/api/sessions/session_1/requests", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceName: huge, publicKeyJwk: { kty: "RSA" } }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Request body too large" });
  });
});

describe("GET /api/events SSE", () => {
  async function readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<string> {
    const { value, done } = await reader.read();
    if (done || !value) return "";
    return new TextDecoder().decode(value);
  }

  test("requires dashboard cookie auth", async () => {
    const res = await api(new Request("http://local/api/events", { method: "GET" }));
    expect(res.status).toBe(401);
  });

  test("streams event: sessions frames; upsert notifies; abort unsubscribes", async () => {
    const cookie = await loginCookie();
    const ac = new AbortController();
    const res = await api(
      new Request("http://local/api/events", {
        method: "GET",
        headers: { cookie, accept: "text/event-stream" },
        signal: ac.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const reader = res.body!.getReader();
    const initial = await readChunk(reader);
    // Contract: named sessions event. Payload is JSON (snapshot or invalidation).
    expect(initial).toContain("event: sessions\n");
    expect(initial).toMatch(/data: \{.*\}\n\n/);
    const initialDataLine = initial
      .split("\n")
      .find((l) => l.startsWith("data: "));
    expect(initialDataLine).toBeTruthy();
    const initialPayload = JSON.parse(initialDataLine!.slice("data: ".length)) as {
      data?: unknown;
    };
    // Initial empty list (or empty invalidation object).
    if ("data" in initialPayload) {
      expect(initialPayload.data).toEqual([]);
    } else {
      expect(initialPayload).toEqual({});
    }

    // Meaningful upsert should push another sessions frame (no real timers).
    upsertSession({
      id: "sse-session-1",
      title: "live",
      cwd: "/tmp/sse",
      startedAt: "2026-08-12T00:00:00.000Z",
    });

    const next = await readChunk(reader);
    expect(next).toContain("event: sessions\n");
    const nextDataLine = next.split("\n").find((l) => l.startsWith("data: "));
    expect(nextDataLine).toBeTruthy();
    const nextPayload = JSON.parse(nextDataLine!.slice("data: ".length)) as {
      data?: Array<{ id: string }>;
    };
    if (Array.isArray(nextPayload.data)) {
      expect(nextPayload.data.some((s) => s.id === "sse-session-1")).toBe(true);
    } else {
      // Invalidation-only contract: empty object still names the sessions event.
      expect(nextPayload).toEqual({});
    }

    ac.abort();
    // After abort, further upserts must not throw; stream is closed.
    upsertSession({
      id: "sse-session-2",
      title: "after-abort",
      cwd: "/tmp/sse2",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
  });
});

describe("pull request readiness and repair launch", () => {
  const prStatus = {
    worktreePath: "/tmp/phone-pr",
    branch: "feature/pr",
    fetchedAt: "2026-08-13T00:00:00.000Z",
    pullRequest: {
      number: 42,
      title: "Fix things",
      url: "https://github.com/acme/app/pull/42",
      baseBranch: "main",
      headBranch: "feature/pr",
      isDraft: false,
      readiness: "checks_failed" as const,
      mergeable: "mergeable" as const,
      reviewDecision: "none" as const,
      checks: {
        state: "failure" as const,
        total: 3,
        failed: 1,
        pending: 0,
      },
      unresolvedThreads: 0,
    },
  };

  test("GET /api/worktrees/pr requires auth and live worktree path", async () => {
    const session = upsertSession({
      id: "pr_status_source",
      title: "PR session",
      cwd: "/tmp/phone-pr",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const path = session.worktree.path;
    const encoded = encodeURIComponent(path);

    const unauthorized = await api(
      new Request(`http://local/api/worktrees/pr?path=${encoded}`),
    );
    expect(unauthorized.status).toBe(401);

    const cookie = await loginCookie();
    const probed: string[] = [];
    const unknown = await handleApi(
      new Request(
        `http://local/api/worktrees/pr?path=${encodeURIComponent("/tmp/not-advertised")}`,
        { headers: { cookie } },
      ),
      config,
      "/api/worktrees/pr",
      async () => {
        throw new Error("must not launch");
      },
      async () => {
        throw new Error("must not create");
      },
      {
        getWorktreePullRequestStatus: async (worktreePath) => {
          probed.push(worktreePath);
          throw new Error("must not probe GitHub");
        },
      },
    );
    expect(unknown?.status).toBe(404);
    expect(probed).toEqual([]);

    const ok = await handleApi(
      new Request(`http://local/api/worktrees/pr?path=${encoded}`, {
        headers: { cookie },
      }),
      config,
      "/api/worktrees/pr",
      async () => {
        throw new Error("must not launch");
      },
      async () => {
        throw new Error("must not create");
      },
      {
        getWorktreePullRequestStatus: async (worktreePath) => ({
          ...prStatus,
          worktreePath,
        }),
      },
    );
    expect(ok?.status).toBe(200);
    expect(await ok?.json()).toEqual({
      data: { ...prStatus, worktreePath: path },
    });
  });

  test("POST /api/worktrees/pr-task validates body, auth, path, and action", async () => {
    const session = upsertSession({
      id: "pr_task_source",
      title: "PR task session",
      cwd: "/tmp/phone-pr-task",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const worktreePath = session.worktree.path;
    const body = { worktreePath, action: "fix_checks" };

    const unauthorized = await api(
      jsonRequest("http://local/api/worktrees/pr-task", body),
    );
    expect(unauthorized.status).toBe(401);

    const cookie = await loginCookie();

    const invalid = await handleApi(
      jsonRequest(
        "http://local/api/worktrees/pr-task",
        { worktreePath, action: "merge_now" },
        { cookie },
      ),
      config,
      "/api/worktrees/pr-task",
    );
    expect(invalid?.status).toBe(400);
    expect(await invalid?.json()).toEqual({ error: "Invalid body" });

    const probed: string[] = [];
    const unknown = await handleApi(
      jsonRequest(
        "http://local/api/worktrees/pr-task",
        { worktreePath: "/tmp/not-advertised", action: "fix_checks" },
        { cookie },
      ),
      config,
      "/api/worktrees/pr-task",
      async () => {
        throw new Error("must not launch");
      },
      async () => {
        throw new Error("must not create");
      },
      {
        getWorktreePullRequestStatus: async (path) => {
          probed.push(path);
          throw new Error("must not probe GitHub");
        },
      },
    );
    expect(unknown?.status).toBe(404);
    expect(probed).toEqual([]);

    const noPr = await handleApi(
      jsonRequest("http://local/api/worktrees/pr-task", body, { cookie }),
      config,
      "/api/worktrees/pr-task",
      async () => {
        throw new Error("must not launch");
      },
      async () => {
        throw new Error("must not create");
      },
      {
        getWorktreePullRequestStatus: async (path) => ({
          worktreePath: path,
          branch: "feature/pr",
          fetchedAt: prStatus.fetchedAt,
          pullRequest: null,
        }),
      },
    );
    expect(noPr?.status).toBe(400);
    expect(await noPr?.json()).toEqual({
      error: "No pull request for worktree",
    });

    const inapplicable = await handleApi(
      jsonRequest(
        "http://local/api/worktrees/pr-task",
        { worktreePath, action: "fix_conflicts" },
        { cookie },
      ),
      config,
      "/api/worktrees/pr-task",
      async () => {
        throw new Error("must not launch");
      },
      async () => {
        throw new Error("must not create");
      },
      {
        getWorktreePullRequestStatus: async (path) => ({
          ...prStatus,
          worktreePath: path,
        }),
      },
    );
    expect(inapplicable?.status).toBe(400);
    expect(await inapplicable?.json()).toEqual({
      error: "Action not applicable",
    });
  });

  test("POST /api/worktrees/pr-task builds server prompt and launches OMP", async () => {
    const session = upsertSession({
      id: "pr_launch_source",
      title: "PR launch session",
      cwd: "/tmp/phone-pr-launch",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const worktreePath = session.worktree.path;
    const cookie = await loginCookie();
    const launched: Array<{ path: string; prompt?: string }> = [];
    const prompts: Array<{ statusPath: string; action: string }> = [];

    const launchedOk = await handleApi(
      jsonRequest(
        "http://local/api/worktrees/pr-task",
        { worktreePath, action: "fix_checks" },
        { cookie },
      ),
      config,
      "/api/worktrees/pr-task",
      async (path, initialPrompt) => {
        launched.push({ path, prompt: initialPrompt });
      },
      async () => {
        throw new Error("must not create");
      },
      {
        getWorktreePullRequestStatus: async (path) => ({
          ...prStatus,
          worktreePath: path,
        }),
        buildPullRequestTask: (status, action) => {
          prompts.push({ statusPath: status.worktreePath, action });
          return `Repair PR #${status.pullRequest?.number} via ${action}`;
        },
      },
    );
    expect(launchedOk?.status).toBe(200);
    expect(await launchedOk?.json()).toEqual({ data: { ok: true } });
    expect(prompts).toEqual([
      { statusPath: worktreePath, action: "fix_checks" },
    ]);
    expect(launched).toEqual([
      {
        path: worktreePath,
        prompt: "Repair PR #42 via fix_checks",
      },
    ]);

    const clientPromptIgnored = await handleApi(
      jsonRequest(
        "http://local/api/worktrees/pr-task",
        {
          worktreePath,
          action: "fix_checks",
          prompt: "client-supplied should be ignored",
        },
        { cookie },
      ),
      config,
      "/api/worktrees/pr-task",
      async (path, initialPrompt) => {
        launched.push({ path, prompt: initialPrompt });
      },
      async () => {
        throw new Error("must not create");
      },
      {
        getWorktreePullRequestStatus: async (path) => ({
          ...prStatus,
          worktreePath: path,
        }),
        buildPullRequestTask: () => "server-built prompt only",
      },
    );
    expect(clientPromptIgnored?.status).toBe(200);
    expect(launched.at(-1)).toEqual({
      path: worktreePath,
      prompt: "server-built prompt only",
    });
  });

  test("plain session launch still omits initial prompt", async () => {
    const session = upsertSession({
      id: "launch_no_prompt",
      title: "Existing session",
      cwd: "/tmp/phone-launch-plain",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const cookie = await loginCookie();
    const calls: Array<{ path: string; prompt?: string; argc: number }> = [];
    const res = await handleApi(
      jsonRequest(
        "http://local/api/sessions/launch",
        { worktreePath: session.worktree.path },
        { cookie },
      ),
      config,
      "/api/sessions/launch",
      async (worktreePath, initialPrompt) => {
        calls.push({
          path: worktreePath,
          prompt: initialPrompt,
          argc: initialPrompt === undefined ? 1 : 2,
        });
      },
    );
    expect(res?.status).toBe(200);
    expect(calls).toEqual([
      { path: session.worktree.path, prompt: undefined, argc: 1 },
    ]);
  });
});
