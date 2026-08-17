/** /api/* handlers for the local single-tenant daemon. */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";


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
  getSessionDashboard,
  isSessionInactive,
  listDashboardLocations,
  listRequestsBySession,
  listSessions,
  registerDashboardLocation,
  registerDashboardLocations,
  removeDashboardLocation,
  subscribeSessionChanges,
  upsertSession,
} from "./store";

import {
  type DashboardLocation,
  type SessionSummary,
  type PullRequestAction,
  type WorktreePullRequestStatus,
  isJsonContentType,
  isNonEmptyString,
  isValidId,
  jsonError,
  jsonOk,
  parseCreateJoinRequestInput,
  parseCreateWorktreeInput,
  parseDeleteWorktreeInput,
  parseMergePullRequestInput,
  parseLaunchPullRequestTaskInput,
  parseLaunchSessionInput,
  parseHostSessionHeartbeat,
  parseRequestDecision,
  readJsonBody,
  stripEncryptedLink,
} from "../lib/contracts";
import {
  createGitWorktree,
  listGitWorktrees,
  removeGitWorktree,
} from "./git-worktree";
import {
  buildPullRequestTask,
  getWorktreePullRequestStatus,
  mergePullRequest,
  isPullRequestActionApplicable,
} from "./github-pr";
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

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** Discover repository worktrees, then prune locations deleted outside the dashboard. */
async function reconcileDashboardLocations(): Promise<void> {
  const checks = new Map<string, Promise<boolean>>();
  const exists = (path: string) => {
    let check = checks.get(path);
    if (!check) {
      check = pathIsDirectory(path);
      checks.set(path, check);
    }
    return check;
  };

  const repositoryLocations = new Map<string, ReturnType<typeof listDashboardLocations>>();
  for (const location of listDashboardLocations()) {
    if (location.group.kind !== "repository") continue;
    const current = repositoryLocations.get(location.group.path) ?? [];
    current.push(location);
    repositoryLocations.set(location.group.path, current);
  }
  const discoveredLocations: DashboardLocation[] = [];
  for (const locations of repositoryLocations.values()) {
    let advertisedPath: string | undefined;
    for (const location of locations) {
      if (await exists(location.worktree.path)) {
        advertisedPath = location.worktree.path;
        break;
      }
    }
    if (!advertisedPath) continue;
    const lastSessionStartedAt = locations.reduce(
      (latest, location) =>
        Date.parse(location.lastSessionStartedAt) > Date.parse(latest)
          ? location.lastSessionStartedAt
          : latest,
      locations[0]!.lastSessionStartedAt,
    );
    for (const worktree of await listGitWorktrees(advertisedPath)) {
      if (!(await exists(worktree.path))) continue;
      discoveredLocations.push({
        group: locations[0]!.group,
        worktree: {
          name: basename(worktree.path) || worktree.path,
          path: worktree.path,
          ...(worktree.branch ? { branch: worktree.branch } : {}),
        },
        lastSessionStartedAt,
      });
    }
  }
  registerDashboardLocations(discoveredLocations);

  const locations = listDashboardLocations();
  const availability = await Promise.all(
    locations.map(async (location) => ({
      location,
      available:
        (await exists(location.group.path)) &&
        (await exists(location.worktree.path)),
    })),
  );
  const sessions = listSessions();
  for (const { location, available } of availability) {
    if (available) continue;
    removeDashboardLocation(location.group.path, location.worktree.path);
    for (const session of sessions) {
      if (
        session.group.path === location.group.path &&
        session.worktree.path === location.worktree.path
      ) {
        deactivateSession(session.id);
      }
    }
  }
}

const DASHBOARD_RECONCILE_INTERVAL_MS = 15_000;
let dashboardReconcilePromise: Promise<void> | undefined;
let dashboardReconciledAt = 0;

function reconcileDashboardLocationsCoalesced(): Promise<void> {
  if (dashboardReconcilePromise) return dashboardReconcilePromise;
  if (Date.now() - dashboardReconciledAt < DASHBOARD_RECONCILE_INTERVAL_MS) {
    return Promise.resolve();
  }
  dashboardReconcilePromise = reconcileDashboardLocations().finally(() => {
    dashboardReconciledAt = Date.now();
    dashboardReconcilePromise = undefined;
  });
  return dashboardReconcilePromise;
}

/** Reset module-level reconciliation state between isolated API tests. */
export function resetDashboardReconciliationForTests(): void {
  dashboardReconcilePromise = undefined;
  dashboardReconciledAt = 0;
}

async function handleDashboard(
  req: Request,
  config: ShareConfig,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  await reconcileDashboardLocationsCoalesced();
  return jsonOk(getSessionDashboard(), {
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


type LaunchOmp = (
  worktreePath: string,
  initialPrompt?: string,
) => Promise<void>;

type CreateWorktree = (advertisedPaths: string[]) => Promise<{ path: string }>;
type RemoveWorktree = (
  repositoryPath: string,
  worktreePath: string,
) => Promise<void>;

type ApiDeps = {
  removeWorktree?: RemoveWorktree;
  getWorktreePullRequestStatus?: (
    worktreePath: string,
  ) => Promise<WorktreePullRequestStatus>;
  buildPullRequestTask?: (
    status: WorktreePullRequestStatus,
    action: PullRequestAction,
  ) => string;
  isPullRequestActionApplicable?: (
    status: WorktreePullRequestStatus,
    action: PullRequestAction,
  ) => boolean;
  mergePullRequest?: (status: WorktreePullRequestStatus) => Promise<void>;
};

export function buildOmpTerminalArgs(
  worktreePath: string,
  ompPath: string,
  initialPrompt?: string,
): string[] {
  const script =
    initialPrompt === undefined
      ? 'tell application "Terminal" to do script "cd " & quoted form of item 1 of argv & " && exec " & quoted form of item 2 of argv'
      : 'tell application "Terminal" to do script "cd " & quoted form of item 1 of argv & " && exec " & quoted form of item 2 of argv & " @/dev/null " & quote & "$(/usr/bin/printf %s " & quoted form of item 3 of argv & " | /usr/bin/base64 -D)" & quote';
  const argv = [
    "/usr/bin/osascript",
    "-e",
    "on run argv",
    "-e",
    script,
    "-e",
    "end run",
    worktreePath,
    ompPath,
  ];
  if (initialPrompt !== undefined) {
    argv.push(Buffer.from(initialPrompt).toString("base64"));
  }
  return argv;
}

async function launchOmpInTerminal(
  worktreePath: string,
  initialPrompt?: string,
): Promise<void> {
  if (!(await stat(worktreePath)).isDirectory()) {
    throw new Error("worktree is not a directory");
  }
  const ompPath = join(homedir(), ".local", "bin", "omp-share");
  const proc = Bun.spawn(buildOmpTerminalArgs(worktreePath, ompPath, initialPrompt), {
    stdout: "ignore",
    stderr: "ignore",
  });
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
  if (
    !listDashboardLocations().some(
      (location) => location.worktree.path === input.worktreePath,
    )
  ) {
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
  const groupLocations = listDashboardLocations().filter(
    (location) => location.group.path === input.groupPath,
  );
  if (groupLocations.length === 0) return err("Repository not found", 404);
  if (groupLocations.every((location) => location.group.kind !== "repository")) {
    return err("Not a git repository", 400);
  }
  const advertisedPaths = [
    ...new Set(
      groupLocations.flatMap((location) => [
        location.group.path,
        location.worktree.path,
      ]),
    ),
  ];

  try {
    const created = await createWorktree(advertisedPaths);
    registerDashboardLocation(created.path);
    await launchOmp(created.path);
    return jsonOk(
      { ok: true, path: created.path },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Not a git repository") return err(message, 400);
    return err("Could not create worktree", 500);
  }
}

function isAdvertisedWorktreePath(worktreePath: string): boolean {
  return listDashboardLocations().some(
    (location) => location.worktree.path === worktreePath,
  );
}

async function handleDeleteWorktree(
  req: Request,
  config: ShareConfig,
  deps: ApiDeps,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const input = parseDeleteWorktreeInput(parsedBody.value);
  if (!input) return err("Invalid body", 400);
  if (input.groupPath === input.worktreePath) {
    return err("Cannot delete the primary worktree", 400);
  }

  const location = listDashboardLocations().find(
    (item) =>
      item.group.kind === "repository" &&
      item.group.path === input.groupPath &&
      item.worktree.path === input.worktreePath,
  );
  if (!location) return err("Worktree not found", 404);
  const sessions = listSessions().filter(
    (session) =>
      session.group.path === input.groupPath &&
      session.worktree.path === input.worktreePath,
  );

  const removeWorktree = deps.removeWorktree ?? removeGitWorktree;
  try {
    await removeWorktree(input.groupPath, input.worktreePath);
    removeDashboardLocation(input.groupPath, input.worktreePath);
    for (const session of sessions) {
      const pid = exclusiveSessionPid(session.id);
      deactivateSession(session.id);
      if (pid !== undefined) killSessionProcess(pid);
    }
    return jsonOk({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Not a git repository" || message === "Cannot delete the primary worktree") {
      return err(message, 400);
    }
    if (message === "Worktree not found") return err(message, 404);
    if (message === "Worktree has uncommitted changes") return err(message, 409);
    return err("Could not delete worktree", 500);
  }
}

async function handleWorktreePullRequest(
  req: Request,
  config: ShareConfig,
  deps: ApiDeps,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);

  const path = new URL(req.url).searchParams.get("path");
  if (!isNonEmptyString(path, 1024)) {
    return err("Invalid path", 400);
  }
  if (!isAdvertisedWorktreePath(path)) {
    return err("Worktree not found", 404);
  }

  const loadStatus = deps.getWorktreePullRequestStatus ?? getWorktreePullRequestStatus;
  try {
    const status = await loadStatus(path);
    return jsonOk(status, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return err("Could not load pull request status", 500);
  }
}

async function handleMergePullRequest(
  req: Request,
  config: ShareConfig,
  deps: ApiDeps,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const input = parseMergePullRequestInput(parsedBody.value);
  if (!input) return err("Invalid body", 400);
  if (!isAdvertisedWorktreePath(input.worktreePath)) {
    return err("Worktree not found", 404);
  }

  const loadStatus = deps.getWorktreePullRequestStatus ?? getWorktreePullRequestStatus;
  let status: WorktreePullRequestStatus;
  try {
    status = await loadStatus(input.worktreePath);
  } catch {
    return err("Could not load pull request status", 500);
  }
  if (!status.pullRequest) return err("No pull request for worktree", 400);
  if (status.pullRequest.readiness !== "ready") {
    return err("Pull request is not ready to merge", 409);
  }

  try {
    await (deps.mergePullRequest ?? mergePullRequest)(status);
    return jsonOk({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return err("Could not merge pull request", 500);
  }
}

async function handleLaunchPullRequestTask(
  req: Request,
  config: ShareConfig,
  launchOmp: LaunchOmp,
  deps: ApiDeps,
): Promise<Response> {
  const auth = await requireDashboardAuth(req, config);
  if (!isAuthOk(auth)) return noStore(auth);
  if (!isJsonContentType(req)) {
    return err("Content-Type must be application/json", 400);
  }
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return err(parsedBody.error, 400);
  const input = parseLaunchPullRequestTaskInput(parsedBody.value);
  if (!input) return err("Invalid body", 400);
  if (!isAdvertisedWorktreePath(input.worktreePath)) {
    return err("Worktree not found", 404);
  }

  const loadStatus = deps.getWorktreePullRequestStatus ?? getWorktreePullRequestStatus;
  const buildTask = deps.buildPullRequestTask ?? buildPullRequestTask;
  const actionApplicable =
    deps.isPullRequestActionApplicable ?? isPullRequestActionApplicable;

  let status: WorktreePullRequestStatus;
  try {
    status = await loadStatus(input.worktreePath);
  } catch {
    return err("Could not load pull request status", 500);
  }

  if (status.pullRequest === null) {
    return err("No pull request for worktree", 400);
  }
  if (!actionApplicable(status, input.action)) {
    return err("Action not applicable", 400);
  }

  let prompt: string;
  try {
    prompt = buildTask(status, input.action);
  } catch {
    return err("Could not start session", 500);
  }

  try {
    await launchOmp(input.worktreePath, prompt);
    return jsonOk({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return err("Could not start session", 500);
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
  createWorktree: CreateWorktree = createGitWorktree,
  deps: ApiDeps = {},
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
  if (pathname === "/api/dashboard" && method === "GET") {
    return handleDashboard(req, config);
  }
  if (pathname === "/api/sessions/launch" && method === "POST") {
    return handleLaunchSession(req, config, launchOmp);
  }
  if (pathname === "/api/sessions/worktrees" && method === "POST") {
    return handleCreateWorktree(req, config, launchOmp, createWorktree);
  }
  if (pathname === "/api/sessions/worktrees" && method === "DELETE") {
    return handleDeleteWorktree(req, config, deps);
  }
  if (pathname === "/api/worktrees/pr" && method === "GET") {
    return handleWorktreePullRequest(req, config, deps);
  }
  if (pathname === "/api/worktrees/pr-task" && method === "POST") {
    return handleLaunchPullRequestTask(req, config, launchOmp, deps);
  }
  if (pathname === "/api/worktrees/pr-merge" && method === "POST") {
    return handleMergePullRequest(req, config, deps);
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
