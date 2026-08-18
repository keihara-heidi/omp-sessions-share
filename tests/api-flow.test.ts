import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShareConfig } from "../shared/config";
import {
  buildOmpTerminalArgs,
  handleApi,
  resetDashboardReconciliationForTests,
} from "../daemon/api";
import { DASHBOARD_COOKIE_NAME } from "../lib/auth";
import { HEALTH_CHECK_IDS, type SystemHealth } from "../lib/contracts";
import {
  configureDashboardDb,
  deactivateSession,
  getSessionDashboard,
  listRecentSessions,
  listSessions,
  removeDashboardLocation,
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

const healthySystem: SystemHealth = {
  overall: "healthy",
  checkedAt: "2026-08-18T12:00:00.000Z",
  checks: HEALTH_CHECK_IDS.map((id) => ({
    id,
    label: id,
    level: "healthy",
    summary: `${id} healthy`,
    checkedAt: "2026-08-18T12:00:00.000Z",
  })),
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

function initGitRepo(dir = mkdtempSync(join(tmpdir(), "omp-api-wt-"))): string {
  mkdirSync(dir, { recursive: true });
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

describe("buildOmpTerminalArgs", () => {
  test("delivers a multiline prompt as one decoded argument", () => {
    const prompt =
      "Resolve Merge Conflicts\n\nGoal:\nPreserve the complete prompt.";
    const args = buildOmpTerminalArgs("/tmp/worktree", "/tmp/omp", prompt);

    expect(args[4]).toContain("$(/usr/bin/printf %s ");
    expect(args[4]).toContain("@/dev/null");
    expect(args[4]).not.toContain(prompt);
    expect(args.at(-1)).not.toContain("\n");
    expect(Buffer.from(args.at(-1)!, "base64").toString()).toBe(prompt);
  });

  test("launches plain sessions without a prompt pipeline", () => {
    const args = buildOmpTerminalArgs("/tmp/worktree", "/tmp/omp");

    expect(args[4]).not.toContain("/usr/bin/base64");
    expect(args[4]).not.toContain("--resume");
    expect(args.at(-1)).toBe("/tmp/omp");
  });

  test("resumes with osascript argv quoted --resume path", () => {
    const sessionFile = "/Users/host/.omp/sessions/abc.jsonl";
    const args = buildOmpTerminalArgs("/tmp/worktree", "/tmp/omp", {
      resumeSessionFile: sessionFile,
    });

    expect(args[4]).toContain("--resume");
    expect(args[4]).toContain("quoted form of item 3 of argv");
    expect(args[4]).not.toContain("/usr/bin/base64");
    expect(args[4]).not.toContain(sessionFile);
    expect(args.at(-1)).toBe(sessionFile);
    expect(args).not.toContain(Buffer.from(sessionFile).toString("base64"));
  });

  test("rejects simultaneous prompt and resumeSessionFile", () => {
    expect(() =>
      buildOmpTerminalArgs("/tmp/worktree", "/tmp/omp", {
        prompt: "hi",
        resumeSessionFile: "/tmp/s.jsonl",
      }),
    ).toThrow(/mutually exclusive/);
  });
});

beforeEach(() => {
  resetStoreForTests();
  resetDashboardReconciliationForTests();
});
afterEach(() => {
  resetStoreForTests();
  resetDashboardReconciliationForTests();
});

describe("local daemon auth gates", () => {
  test("password cookie login and reject bad password", async () => {
    expect(
      (await api(new Request("http://local/api/sessions", { method: "GET" })))
        .status,
    ).toBe(401);

    const bad = await api(
      jsonRequest("http://local/api/auth/login", {
        password: "nope-nope-nope",
      }),
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

  test("system health requires auth, disables HTTP caching, and fixes provider errors", async () => {
    let calls = 0;
    const unauthorized = await handleApi(
      new Request("http://local/api/system/health"),
      config,
      "/api/system/health",
      undefined,
      undefined,
      {
        getSystemHealth: async () => {
          calls += 1;
          return healthySystem;
        },
      },
    );
    expect(unauthorized?.status).toBe(401);
    expect(unauthorized?.headers.get("cache-control")).toBe("no-store");
    expect(calls).toBe(0);

    const cookie = await loginCookie();
    const request = new Request("http://local/api/system/health", {
      headers: { cookie },
    });
    const ok = await handleApi(
      request,
      config,
      "/api/system/health",
      undefined,
      undefined,
      { getSystemHealth: async () => healthySystem },
    );
    expect(ok?.status).toBe(200);
    expect(ok?.headers.get("cache-control")).toBe("no-store");
    expect(await ok?.json()).toEqual({ data: healthySystem });

    const failed = await handleApi(
      request,
      config,
      "/api/system/health",
      undefined,
      undefined,
      {
        getSystemHealth: async () => {
          throw new Error("secret stderr /private/path");
        },
      },
    );
    expect(failed?.status).toBe(503);
    expect(failed?.headers.get("cache-control")).toBe("no-store");
    expect(await failed?.json()).toEqual({ error: "Service unavailable" });
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

  test("registers a repository, a plain directory, and every repository below a project folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-api-register-"));
    const repository = initGitRepo(join(root, "single"));
    const folder = join(root, "plain-folder");
    const project = join(root, "project");
    const projectRepoA = initGitRepo(join(project, "api"));
    const projectRepoB = initGitRepo(join(project, "packages", "web"));
    mkdirSync(folder);

    try {
      for (const path of [repository, folder]) {
        const response = await api(
          jsonRequest("http://local/api/host/locations", { path }, hostHeaders),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          data: { locations: Array<{ group: { path: string } }> };
        };
        expect(
          body.data.locations.map((location) => location.group.path),
        ).toEqual([realpathSync(path)]);
      }

      const projectResponse = await api(
        jsonRequest(
          "http://local/api/host/locations",
          { path: project },
          hostHeaders,
        ),
      );
      expect(projectResponse.status).toBe(200);
      const projectBody = (await projectResponse.json()) as {
        data: { locations: Array<{ group: { path: string } }> };
      };
      expect(
        projectBody.data.locations
          .map((location) => location.group.path)
          .sort(),
      ).toEqual(
        [realpathSync(projectRepoA), realpathSync(projectRepoB)].sort(),
      );

      const cookie = await loginCookie();
      const dashboard = await api(
        new Request("http://local/api/dashboard", { headers: { cookie } }),
      );
      const dashboardBody = (await dashboard.json()) as {
        data: { locations: Array<{ group: { path: string } }> };
      };
      expect(
        dashboardBody.data.locations
          .map((location) => location.group.path)
          .sort(),
      ).toEqual(
        [repository, folder, projectRepoA, projectRepoB]
          .map((path) => realpathSync(path))
          .sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers every existing worktree for a remembered repository", async () => {
    const repo = initGitRepo();
    const linked = await createGitWorktree([repo]);
    try {
      const session = upsertSession({
        id: "worktree_discovery_source",
        title: "Repository source",
        cwd: repo,
        startedAt: "2026-08-12T00:00:00.000Z",
      });
      expect(deactivateSession(session.id)).toBe(true);

      const cookie = await loginCookie();
      const res = await api(
        new Request("http://local/api/dashboard", { headers: { cookie } }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          sessions: unknown[];
          locations: Array<{ worktree: { path: string } }>;
          recentSessions: unknown[];
        };
      };
      expect(body.data.sessions).toEqual([]);
      expect(
        body.data.locations.map((location) => location.worktree.path).sort(),
      ).toEqual([realpathSync(repo), realpathSync(linked.path)].sort());
    } finally {
      rmSync(linked.path, { recursive: true, force: true });
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
        data: { sessions: [], locations: [], recentSessions: [] },
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
      data: { sessions: [], locations: [], recentSessions: [] },
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
    expect(
      (await api(new Request(`http://local${path}`, { method: "POST" })))
        .status,
    ).toBe(401);
    const cookie = await loginCookie();
    const removed = await api(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ data: { ok: true } });

    const repeatedHeartbeat = await api(
      jsonRequest("http://local/api/host/sessions", heartbeatBody, hostHeaders),
    );
    expect(await repeatedHeartbeat.json()).toEqual({
      data: { inactive: true },
    });
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
    const publicKeyJwk = await crypto.subtle.exportKey(
      "jwk",
      keyPair.publicKey,
    );

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
    const publicKeyJwk = await crypto.subtle.exportKey(
      "jwk",
      keyPair.publicKey,
    );
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
        body: JSON.stringify({
          deviceName: huge,
          publicKeyJwk: { kty: "RSA" },
        }),
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
    const res = await api(
      new Request("http://local/api/events", { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  test("streams dashboard snapshots; upsert notifies; abort unsubscribes", async () => {
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
    expect(res.headers.get("content-type") ?? "").toContain(
      "text/event-stream",
    );

    const reader = res.body!.getReader();
    const initial = await readChunk(reader);
    expect(initial).toContain("event: dashboard\n");
    const initialDataLine = initial
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(initialDataLine).toBeTruthy();
    const initialPayload = JSON.parse(
      initialDataLine!.slice("data: ".length),
    ) as {
      data: {
        sessions: unknown[];
        locations: unknown[];
        recentSessions: unknown[];
      };
    };
    expect(initialPayload.data).toEqual({
      sessions: [],
      locations: [],
      recentSessions: [],
    });

    // Meaningful host changes push the complete dashboard without a follow-up fetch.
    upsertSession({
      id: "sse-session-1",
      title: "live",
      cwd: "/tmp/sse",
      startedAt: "2026-08-12T00:00:00.000Z",
    });

    const next = await readChunk(reader);
    expect(next).toContain("event: dashboard\n");
    const nextDataLine = next
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(nextDataLine).toBeTruthy();
    const nextPayload = JSON.parse(nextDataLine!.slice("data: ".length)) as {
      data: {
        sessions: Array<{ id: string }>;
        locations: Array<{ worktree: { path: string } }>;
        recentSessions: unknown[];
      };
    };
    expect(
      nextPayload.data.sessions.some(
        (session) => session.id === "sse-session-1",
      ),
    ).toBe(true);
    expect(
      nextPayload.data.locations.some(
        (location) => location.worktree.path === "/tmp/sse",
      ),
    ).toBe(true);

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

  test("POST /api/worktrees/pr-merge runs the direct merge action without OMP", async () => {
    const session = upsertSession({
      id: "pr_merge_source",
      title: "PR merge session",
      cwd: "/tmp/phone-pr-merge",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const worktreePath = session.worktree.path;
    const body = { worktreePath };
    const unauthorized = await api(
      jsonRequest("http://local/api/worktrees/pr-merge", body),
    );
    expect(unauthorized.status).toBe(401);

    const cookie = await loginCookie();
    const merged: number[] = [];
    const response = await handleApi(
      jsonRequest("http://local/api/worktrees/pr-merge", body, { cookie }),
      config,
      "/api/worktrees/pr-merge",
      async () => {
        throw new Error("must not launch OMP");
      },
      async () => {
        throw new Error("must not create");
      },
      {
        getWorktreePullRequestStatus: async (path) => ({
          ...prStatus,
          worktreePath: path,
          pullRequest: {
            ...prStatus.pullRequest,
            readiness: "ready",
            checks: { state: "success", total: 3, failed: 0, pending: 0 },
          },
        }),
        mergePullRequest: async (status) => {
          merged.push(status.pullRequest!.number);
        },
      },
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ data: { ok: true } });
    expect(merged).toEqual([42]);
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
      async (path, init) => {
        launched.push({
          path,
          prompt: typeof init === "string" ? init : init?.prompt,
        });
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
      async (path, init) => {
        launched.push({
          path,
          prompt: typeof init === "string" ? init : init?.prompt,
        });
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
      async (worktreePath, init) => {
        calls.push({
          path: worktreePath,
          prompt: typeof init === "string" ? init : init?.prompt,
          argc: init === undefined ? 1 : 2,
        });
      },
    );
    expect(res?.status).toBe(200);
    expect(calls).toEqual([
      { path: session.worktree.path, prompt: undefined, argc: 1 },
    ]);
  });

  test("session launch rejects removed prompt input", async () => {
    const session = upsertSession({
      id: "launch_removed_prompt",
      title: "Existing session",
      cwd: "/tmp/phone-launch-prompt-removed",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    const cookie = await loginCookie();
    let launched = false;
    const res = await handleApi(
      jsonRequest(
        "http://local/api/sessions/launch",
        { worktreePath: session.worktree.path, prompt: "removed" },
        { cookie },
      ),
      config,
      "/api/sessions/launch",
      async () => {
        launched = true;
      },
    );

    expect(res?.status).toBe(400);
    expect(launched).toBe(false);
  });
});

describe("recent session resume", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function openTempDashboard(): string {
    const root = mkdtempSync(join(tmpdir(), "omp-api-resume-"));
    tempRoots.push(root);
    configureDashboardDb(join(root, "dashboard.sqlite"));
    return root;
  }

  function writeSessionFile(root: string, name = "session.jsonl"): string {
    const sessionFile = join(root, name);
    writeFileSync(sessionFile, '{"type":"session"}\n');
    return sessionFile;
  }

  function seedRecent(sessionId = "resume_seed_1"): {
    resumeId: string;
    sessionId: string;
    sessionFile: string;
    worktreePath: string;
    cwd: string;
  } {
    const root = openTempDashboard();
    const cwd = mkdtempSync(join(root, "wt-"));
    const sessionFile = writeSessionFile(root);
    const session = upsertSession({
      id: sessionId,
      title: "Remembered",
      cwd,
      startedAt: "2026-08-12T00:00:00.000Z",
      sessionFile,
    });
    expect(deactivateSession(session.id)).toBe(true);
    const resumeId = listRecentSessions()[0]?.id;
    if (!resumeId) throw new Error("missing resume id");
    return {
      resumeId,
      sessionId: session.id,
      sessionFile,
      worktreePath: session.worktree.path,
      cwd,
    };
  }

  test("cookie resume launches exact stored worktree and sessionFile", async () => {
    const seeded = seedRecent();
    const cookie = await loginCookie();
    const launches: Array<{ path: string; init?: unknown }> = [];
    const path = `/api/recent-sessions/${seeded.resumeId}/resume`;
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
    expect(res?.headers.get("cache-control")).toBe("no-store");
    const body = await res!.json();
    expect(body).toEqual({ data: { ok: true } });
    expect(JSON.stringify(body)).not.toContain("sessionFile");
    expect(JSON.stringify(body)).not.toContain(seeded.sessionFile);
    expect(launches).toEqual([
      {
        path: seeded.worktreePath,
        init: { resumeSessionFile: seeded.sessionFile },
      },
    ]);
  });

  test("host bearer alone cannot resume", async () => {
    const seeded = seedRecent();
    const path = `/api/recent-sessions/${seeded.resumeId}/resume`;
    let launched = false;
    const res = await handleApi(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.hostToken}` },
      }),
      config,
      path,
      async () => {
        launched = true;
      },
    );
    expect(res?.status).toBe(401);
    expect(launched).toBe(false);
  });

  test("unknown resumeId is a generic 404", async () => {
    openTempDashboard();
    const cookie = await loginCookie();
    const path = "/api/recent-sessions/does_not_exist/resume";
    let launched = false;
    const res = await handleApi(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { cookie },
      }),
      config,
      path,
      async () => {
        launched = true;
      },
    );
    expect(res?.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "Session not found" });
    expect(launched).toBe(false);
  });

  test("live session rejects resume with 409", async () => {
    const root = openTempDashboard();
    const cwd = mkdtempSync(join(root, "wt-"));
    const sessionFile = writeSessionFile(root);
    upsertSession({
      id: "still_live",
      title: "Live",
      cwd,
      startedAt: "2026-08-12T00:00:00.000Z",
      sessionFile,
    });
    deactivateSession("still_live");
    const resumeId = listRecentSessions()[0]!.id;
    upsertSession({
      id: "still_live",
      title: "Live again",
      cwd,
      startedAt: "2026-08-12T00:00:00.000Z",
      sessionFile,
    });

    const cookie = await loginCookie();
    const path = `/api/recent-sessions/${resumeId}/resume`;
    let launched = false;
    const res = await handleApi(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { cookie },
      }),
      config,
      path,
      async () => {
        launched = true;
      },
    );
    expect(res?.status).toBe(409);
    expect(launched).toBe(false);
  });

  test("missing jsonl rejects without launching", async () => {
    const root = openTempDashboard();
    const cwd = mkdtempSync(join(root, "wt-"));
    const sessionFile = join(root, "missing.jsonl");
    upsertSession({
      id: "missing_file",
      title: "Gone file",
      cwd,
      startedAt: "2026-08-12T00:00:00.000Z",
      sessionFile,
    });
    deactivateSession("missing_file");
    const resumeId = listRecentSessions()[0]!.id;
    const cookie = await loginCookie();
    const path = `/api/recent-sessions/${resumeId}/resume`;
    let launched = false;
    const res = await handleApi(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { cookie },
      }),
      config,
      path,
      async () => {
        launched = true;
      },
    );
    expect(res?.status).toBe(404);
    expect(launched).toBe(false);
    expect(JSON.stringify(await res!.json())).not.toContain(sessionFile);
  });

  test("nonregular session path rejects without launching", async () => {
    const root = openTempDashboard();
    const cwd = mkdtempSync(join(root, "wt-"));
    const sessionFile = join(root, "dir.jsonl");
    mkdirSync(sessionFile);
    upsertSession({
      id: "dir_file",
      title: "Dir not file",
      cwd,
      startedAt: "2026-08-12T00:00:00.000Z",
      sessionFile,
    });
    deactivateSession("dir_file");
    const resumeId = listRecentSessions()[0]!.id;
    const cookie = await loginCookie();
    const path = `/api/recent-sessions/${resumeId}/resume`;
    let launched = false;
    const res = await handleApi(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { cookie },
      }),
      config,
      path,
      async () => {
        launched = true;
      },
    );
    expect(res?.status).toBe(404);
    expect(launched).toBe(false);
  });

  test("missing worktree directory rejects resume", async () => {
    const seeded = seedRecent("missing_wt");
    rmSync(seeded.cwd, { recursive: true, force: true });
    const cookie = await loginCookie();
    const path = `/api/recent-sessions/${seeded.resumeId}/resume`;
    let launched = false;
    const res = await handleApi(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { cookie },
      }),
      config,
      path,
      async () => {
        launched = true;
      },
    );
    expect(res?.status).toBe(404);
    expect(launched).toBe(false);
  });

  test("unadvertised worktree rejects after location removal cascade", async () => {
    const seeded = seedRecent("unadvertised");
    const location = getSessionDashboard().locations[0]!;
    expect(
      removeDashboardLocation(location.group.path, location.worktree.path),
    ).toBe(true);
    expect(listRecentSessions()).toEqual([]);

    const cookie = await loginCookie();
    const path = `/api/recent-sessions/${seeded.resumeId}/resume`;
    let launched = false;
    const res = await handleApi(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { cookie },
      }),
      config,
      path,
      async () => {
        launched = true;
      },
    );
    expect(res?.status).toBe(404);
    expect(launched).toBe(false);
  });

  test("concurrent resume posts spawn once", async () => {
    const seeded = seedRecent("concurrent");
    const cookie = await loginCookie();
    const path = `/api/recent-sessions/${seeded.resumeId}/resume`;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launches = 0;
    const launch = async () => {
      launches += 1;
      await gate;
    };

    const req = () =>
      handleApi(
        new Request(`http://local${path}`, {
          method: "POST",
          headers: { cookie },
        }),
        config,
        path,
        launch,
      );

    const p1 = req();
    for (let i = 0; i < 20 && launches === 0; i++) {
      await Bun.sleep(1);
    }
    expect(launches).toBe(1);
    const p2 = req();
    const second = await p2;
    expect(second?.status).toBe(409);
    release();
    const first = await p1;
    expect(first?.status).toBe(200);
    expect(launches).toBe(1);
  });

  test("dashboard prune of deleted worktree drops resume rows via store", async () => {
    const seeded = seedRecent("prune_resume");
    expect(listRecentSessions().length).toBe(1);
    rmSync(seeded.cwd, { recursive: true, force: true });

    const cookie = await loginCookie();
    const res = await api(
      new Request("http://local/api/dashboard", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { sessions: [], locations: [], recentSessions: [] },
    });
    expect(listRecentSessions()).toEqual([]);
  });
});
