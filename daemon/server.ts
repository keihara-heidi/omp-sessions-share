/** Local omp-sessions-share daemon: API + static dashboard + collab relay. */

import { resolve as pathResolve } from "node:path";
import {
  getDashboardDbPath,
  getDashboardLocationsPath,
  getShareConfigPath,
  loadShareConfigOrThrow,
  listenEndpoint,
  type ShareConfig,
} from "../shared/config";
import { handleApi, SERVER_IDLE_TIMEOUT_SECONDS } from "./api";
import {
  matchRelayPath,
  relayWebSocket,
  shutdownRelay,
  tryUpgradeRelay,
  type SocketData,
} from "./relay";
import { MacSleepInhibitor } from "./sleep-inhibitor";
import { resolveWebRoot, serveStatic } from "./static";
import {
  closeDashboardPersistence,
  configureDashboardDb,
  flushDashboardDb,
  listSessions,
  subscribeSessionChanges,
} from "./store";
import { createSystemHealthService } from "./system-health";
import { createSystemMetricsService } from "./system-metrics";
import { createPluginUpdateService } from "./plugin-update";

/** Pathname only — never query, body, headers, or secrets. */
export function formatAccessLogLine(input: {
  at: Date;
  method: string;
  pathname: string;
  status: number;
  durationMs: number;
}): string {
  const ts = input.at.toISOString();
  const method = input.method.toUpperCase();
  const ms = Math.max(0, Math.round(input.durationMs));
  return `${ts} ${method} ${input.pathname} ${input.status} ${ms}ms`;
}

function logAccess(
  request: Request,
  pathname: string,
  status: number,
  startedAt: number,
): void {
  if (pathname !== "/healthz" && !pathname.startsWith("/api/")) return;
  // LaunchAgent captures stdout to ~/.omp/logs/omp-sessions-share.log
  console.log(
    formatAccessLogLine({
      at: new Date(),
      method: request.method,
      pathname,
      status,
      durationMs: performance.now() - startedAt,
    }),
  );
}

async function main(): Promise<void> {
  const configPath =
    process.env.OMP_SESSIONS_SHARE_CONFIG?.trim() || getShareConfigPath();
  const config: ShareConfig = await loadShareConfigOrThrow(configPath);
  configureDashboardDb(getDashboardDbPath(), getDashboardLocationsPath());
  const { hostname, port } = listenEndpoint(config);
  const webRoot = resolveWebRoot();

  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(
      `daemon must bind loopback only (got hostname ${hostname} from localOrigin)`,
    );
  }

  const sleepInhibitor = new MacSleepInhibitor();
  const systemHealth = createSystemHealthService({
    isSleepInhibitorActive: () => sleepInhibitor.active,
    isSleepInhibitorRequired: () => listSessions().length > 0,
  });
  const systemMetrics = createSystemMetricsService();
  const pluginUpdate = createPluginUpdateService();
  const apiDeps = {
    getSystemHealth: systemHealth.getHealth,
    getHostMetrics: systemMetrics.getMetrics,
    subscribeHostMetrics: systemMetrics.subscribe,
    checkPluginUpdate: pluginUpdate.check,
    startPluginUpdate: pluginUpdate.start,
  };

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 16_384,
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    async fetch(request, bunServer) {
      const startedAt = performance.now();
      const url = new URL(request.url);
      const { pathname } = url;

      const respond = (response: Response): Response => {
        logAccess(request, pathname, response.status, startedAt);
        return response;
      };

      if (pathname === "/healthz") {
        return respond(Response.json({ ok: true }));
      }

      const room = matchRelayPath(pathname);
      if (room) {
        const role = url.searchParams.get("role");
        if (role !== "host" && role !== "guest") {
          return respond(new Response("not found", { status: 404 }));
        }
        const upgraded = tryUpgradeRelay(
          request,
          bunServer,
          room.roomId,
          role,
        );
        if (!upgraded) {
          return respond(
            new Response("websocket upgrade required", { status: 426 }),
          );
        }
        // Successful upgrade has no HTTP response body status to log.
        logAccess(request, pathname, 101, startedAt);
        return upgraded;
      }

      if (pathname.startsWith("/api/")) {
        const res = await handleApi(
          request,
          config,
          pathname,
          undefined,
          undefined,
          apiDeps,
        );
        return respond(res ?? new Response("not found", { status: 404 }));
      }

      if (request.method === "GET" || request.method === "HEAD") {
        return respond(await serveStatic(webRoot, pathname));
      }

      return respond(new Response("method not allowed", { status: 405 }));
    },
    websocket: relayWebSocket,
  });

  const unsubscribeSessions = subscribeSessionChanges((sessions) => {
    if (sessions.length > 0) sleepInhibitor.start();
    else sleepInhibitor.stop();
  });

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    unsubscribeSessions();
    systemMetrics.stop();
    sleepInhibitor.stop();
    shutdownRelay();
    try {
      flushDashboardDb();
    } catch {
      // still close
    }
    try {
      closeDashboardPersistence();
    } catch {
      // best-effort shutdown
    }
    server.stop(true);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `OMP sessions-share daemon listening on http://127.0.0.1:${server.port}`,
  );
  console.log(`  config: ${configPath}`);
  console.log(`  web:    ${webRoot}`);
  console.log(`  public: ${config.publicOrigin}`);
}

const isDirectRun =
  typeof Bun !== "undefined" &&
  !!Bun.main &&
  pathResolve(Bun.main) === pathResolve(import.meta.path);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
