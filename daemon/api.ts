/** /api/* handlers for the local single-tenant daemon. */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";


import type { ShareConfig } from "../shared/config";
import {
  expireDashboardCookie,
  isAuthOk,
  issueDashboardCookie,
  requireDashboardAuth,
  requireHostAuth,
  verifyPassword,
} from "./auth";
import {
  LOGIN_ATTEMPT_WINDOW_SECONDS,
  consumeLoginAttempt,
  createRequest,
  deactivateSession,
  decideRequest,
  exclusiveSessionPid,
  getRequest,
  isSessionInactive,
  listRequestsBySession,
  listSessions,
  subscribeSessionChanges,
  upsertSession,
} from "./store";

import {
  type SessionSummary,
  isJsonContentType,
  isNonEmptyString,
  isValidId,
  jsonError,
  jsonOk,
  parseCreateJoinRequestInput,
  parseCreateWorktreeInput,
  parseLaunchSessionInput,
  parseHostSessionHeartbeat,
  parseRequestDecision,
  readJsonBody,
  stripEncryptedLink,
} from "../lib/contracts";
import { createBlankWorktree } from "./sc-worktree";
import { killSessionProcess } from "./session-process";


function err(
  error: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  const res = jsonError(error, status);
  res.headers.set("Cache-Control", "no-store");
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  }
  return res;
}

function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function usesSecureCookie(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  if (forwarded) return forwarded === "https";
  const host = request.headers.get("host")?.split(":", 1)[0]?.toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1";
}


async function handleLogin(
  req: Request,
  config: ShareConfig,
): Promise<Response> {
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const body = parsedBody.value;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return err("Invalid body", 400);
  }
  const { password } = body as { password?: unknown };
  if (!isNonEmptyString(password, 512)) {
    return err("Invalid password", 400);
  }

  if (!consumeLoginAttempt()) {
    return err("Too many attempts", 429, {
      "Retry-After": String(LOGIN_ATTEMPT_WINDOW_SECONDS),
    });
  }

  if (!verifyPassword(password, config)) {
    return err("Unauthorized", 401);
  }

  const cookie = await issueDashboardCookie(config, usesSecureCookie(req));
  const res = jsonOk(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  res.headers.set("Set-Cookie", cookie);
  return res;
}

function handleLogout(req: Request): Response {
  const res = jsonOk(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  res.headers.set("Set-Cookie", expireDashboardCookie(usesSecureCookie(req)));
  return res;
}

async function handleMeta(
  req: Request,
  config: ShareConfig,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  return jsonOk(
    { publicOrigin: config.publicOrigin },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function handleListSessions(
  req: Request,
  config: ShareConfig,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  return jsonOk(listSessions(), {
    headers: { "Cache-Control": "no-store" },
  });
}

const SSE_KEEPALIVE_MS = 15_000;

async function handleEvents(
  req: Request,
  config: ShareConfig,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);

  const encoder = new TextEncoder();
  let unsub: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const sendSessions = (sessions: SessionSummary[]) => {
        enqueue(
          `event: sessions\ndata: ${JSON.stringify({ data: sessions })}\n\n`,
        );
      };



      // Initial snapshot so clients need no separate bootstrap fetch.
      sendSessions(listSessions());

      unsub = subscribeSessionChanges((sessions) => {
        sendSessions(sessions);
      });

      keepalive = setInterval(() => {
        enqueue(`: ka\n\n`);
      }, SSE_KEEPALIVE_MS);
      if (typeof keepalive === "object" && keepalive && "unref" in keepalive) {
        keepalive.unref();
      }

      const onAbort = () => {
        if (closed) return;
        closed = true;
        unsub?.();
        unsub = undefined;
        if (keepalive !== undefined) {
          clearInterval(keepalive);
          keepalive = undefined;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      closed = true;
      unsub?.();
      unsub = undefined;
      if (keepalive !== undefined) {
        clearInterval(keepalive);
        keepalive = undefined;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}


type LaunchOmp = (worktreePath: string) => Promise<void>;

type CreateWorktree = (advertisedPaths: string[]) => Promise<{ path: string }>;

async function launchOmpInTerminal(worktreePath: string): Promise<void> {
  if (!(await stat(worktreePath)).isDirectory()) {
    throw new Error("worktree is not a directory");
  }
  const ompPath = join(homedir(), ".local", "bin", "omp");
  const proc = Bun.spawn(
    [
      "/usr/bin/osascript",
      "-e",
      "on run argv",
      "-e",
      'tell application "Terminal" to do script "cd " & quoted form of item 1 of argv & " && exec " & quoted form of item 2 of argv',
      "-e",
      "end run",
      worktreePath,
      ompPath,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await proc.exited) !== 0) throw new Error("Terminal launch failed");
}

async function handleLaunchSession(
  req: Request,
  config: ShareConfig,
  launchOmp: LaunchOmp,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const input = parseLaunchSessionInput(parsedBody.value);
  if (!input) return err("Invalid body", 400);
  if (!listSessions().some((session) => session.worktree.path === input.worktreePath)) {
    return err("Worktree not found", 404);
  }

  try {
    await launchOmp(input.worktreePath);
    return jsonOk({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return err("Could not start session", 500);
  }
}

async function handleCreateWorktree(
  req: Request,
  config: ShareConfig,
  launchOmp: LaunchOmp,
  createWorktree: CreateWorktree,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const input = parseCreateWorktreeInput(parsedBody.value);
  if (!input) return err("Invalid body", 400);
  const advertisedPaths = [
    ...new Set(
      listSessions()
        .filter((session) => session.group.path === input.groupPath)
        .flatMap((session) => [session.group.path, session.worktree.path]),
    ),
  ];
  if (advertisedPaths.length === 0) return err("Repository not found", 404);

  try {
    const created = await createWorktree(advertisedPaths);
    await launchOmp(created.path);
    return jsonOk(
      { ok: true, path: created.path },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Project not found" || message === "Not a git repository") {
      return err(message, message === "Project not found" ? 404 : 400);
    }
    return err("Could not create worktree", 500);
  }
}

async function handleDeactivateSession(
  req: Request,
  config: ShareConfig,
  sessionId: string,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isValidId(sessionId)) return err("Invalid sessionId", 400);
  const pid = exclusiveSessionPid(sessionId);
  if (!deactivateSession(sessionId)) return err("Session not found", 404);
  if (pid !== undefined) killSessionProcess(pid);
  return jsonOk({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

async function handleCreateRequest(
  req: Request,
  config: ShareConfig,
  sessionId: string,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isValidId(sessionId)) return err("Invalid sessionId", 400);
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const input = parseCreateJoinRequestInput(parsedBody.value);
  if (!input) return err("Invalid body", 400);

  try {
    const request = createRequest({ sessionId, ...input });
    return jsonOk(request, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "session not found") return err("Session not found", 404);
    return err("Bad request", 400);
  }
}

async function handlePollRequest(
  req: Request,
  config: ShareConfig,
  requestId: string,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isValidId(requestId)) return err("Invalid requestId", 400);

  const request = getRequest(requestId);
  if (!request) return err("Request not found", 404);

  if (request.status === "approved" && request.encryptedLink) {
    return jsonOk(
      {
        ...stripEncryptedLink(request),
        encryptedLink: {
          algorithm: "RSA-OAEP-256" as const,
          ciphertext: request.encryptedLink.ciphertext,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return jsonOk(stripEncryptedLink(request), {
    headers: { "Cache-Control": "no-store" },
  });
}

async function handleHostHeartbeat(
  req: Request,
  config: ShareConfig,
): Promise<Response> {
  const auth = requireHostAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const input = parseHostSessionHeartbeat(parsedBody.value);
  if (!input) return err("Invalid body", 400);
  if (isSessionInactive(input.id)) {
    return jsonOk({ inactive: true }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const session = upsertSession(input);
    return jsonOk(session, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return err("Bad request", 400);
  }
}

function handleHostListRequests(req: Request, config: ShareConfig): Response {
  const auth = requireHostAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!isValidId(sessionId)) return err("Invalid sessionId", 400);
  if (isSessionInactive(sessionId)) {
    return jsonOk([], { headers: { "Cache-Control": "no-store" } });
  }
  const requests = listRequestsBySession(sessionId);
  if (requests === null) return err("Session not found", 404);
  return jsonOk(requests, { headers: { "Cache-Control": "no-store" } });
}

async function handleHostDecide(
  req: Request,
  config: ShareConfig,
  requestId: string,
): Promise<Response> {
  const auth = requireHostAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isValidId(requestId)) return err("Invalid requestId", 400);
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const decision = parseRequestDecision(parsedBody.value);
  if (!decision) return err("Invalid body", 400);

  const existing = getRequest(requestId);
  if (!existing) return err("Request not found", 404);
  if (existing.sessionId !== decision.sessionId) {
    return err("Request does not belong to session", 409);
  }
  if (existing.status !== "pending") {
    return err("Request already decided", 409);
  }

  let updated;
  try {
    updated = decideRequest({ requestId, ...decision });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "session mismatch" || msg === "request already decided") {
      return err("Conflict", 409);
    }
    if (msg === "session not found") return err("Session not found", 404);
    return err("Conflict", 409);
  }
  if (!updated) return err("Request not found", 404);

  if (updated.status === "approved" && updated.encryptedLink) {
    return jsonOk(
      {
        ...stripEncryptedLink(updated),
        encryptedLink: {
          algorithm: "RSA-OAEP-256" as const,
          ciphertext: updated.encryptedLink.ciphertext,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return jsonOk(stripEncryptedLink(updated), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Route /api/* — returns null when path is not under /api/. */
export async function handleApi(
  req: Request,
  config: ShareConfig,
  pathname: string,
  launchOmp: LaunchOmp = launchOmpInTerminal,
  createWorktree: CreateWorktree = createBlankWorktree,
): Promise<Response | null> {
  if (!pathname.startsWith("/api/")) return null;
  const method = req.method.toUpperCase();

  if (pathname === "/api/auth/login" && method === "POST") {
    return handleLogin(req, config);
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    return handleLogout(req);
  }
  if (pathname === "/api/meta" && method === "GET") {
    return handleMeta(req, config);
  }
  if (pathname === "/api/sessions" && method === "GET") {
    return handleListSessions(req, config);
  }
  if (pathname === "/api/sessions/launch" && method === "POST") {
    return handleLaunchSession(req, config, launchOmp);
  }
  if (pathname === "/api/sessions/worktrees" && method === "POST") {
    return handleCreateWorktree(req, config, launchOmp, createWorktree);
  }
  if (pathname === "/api/events" && method === "GET") {
    return handleEvents(req, config);
  }


  {
    const m = /^\/api\/sessions\/([^/]+)\/deactivate$/.exec(pathname);
    if (m && method === "POST") {
      return handleDeactivateSession(req, config, decodeURIComponent(m[1]!));
    }
  }
  {
    const m = /^\/api\/sessions\/([^/]+)\/requests$/.exec(pathname);
    if (m && method === "POST") {
      return handleCreateRequest(req, config, decodeURIComponent(m[1]!));
    }
  }
  {
    const m = /^\/api\/requests\/([^/]+)$/.exec(pathname);
    if (m && method === "GET") {
      return handlePollRequest(req, config, decodeURIComponent(m[1]!));
    }
  }

  if (pathname === "/api/host/sessions" && method === "POST") {
    return handleHostHeartbeat(req, config);
  }
  if (pathname === "/api/host/requests" && method === "GET") {
    return handleHostListRequests(req, config);
  }
  {
    const m = /^\/api\/host\/requests\/([^/]+)$/.exec(pathname);
    if (m && method === "POST") {
      return handleHostDecide(req, config, decodeURIComponent(m[1]!));
    }
  }

  return err("not found", 404);
}
