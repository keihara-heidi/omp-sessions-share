import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ShareConfig } from "../shared/config";
import { handleApi } from "../daemon/api";
import { DASHBOARD_COOKIE_NAME } from "../lib/auth";
import { resetStoreForTests } from "../daemon/store";

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
