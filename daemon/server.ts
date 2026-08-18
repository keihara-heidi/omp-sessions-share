/** Local omp-sessions-share daemon: API + static dashboard + collab relay. */

import {
  getDashboardDbPath,
  getDashboardLocationsPath,
  getShareConfigPath,
  loadShareConfigOrThrow,
  listenEndpoint,
  type ShareConfig,
} from "../shared/config";
import { handleApi } from "./api";
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
  subscribeSessionChanges,
} from "./store";

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

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 16_384,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/healthz") {
        return Response.json({ ok: true });
      }

      const room = matchRelayPath(pathname);
      if (room) {
        const role = url.searchParams.get("role");
        if (role !== "host" && role !== "guest") {
          return new Response("not found", { status: 404 });
        }
        return (
          tryUpgradeRelay(request, bunServer, room.roomId, role) ??
          new Response("websocket upgrade required", { status: 426 })
        );
      }

      if (pathname.startsWith("/api/")) {
        const res = await handleApi(request, config, pathname);
        return res ?? new Response("not found", { status: 404 });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        return serveStatic(webRoot, pathname);
      }

      return new Response("method not allowed", { status: 405 });
    },
    websocket: relayWebSocket,
  });

  const sleepInhibitor = new MacSleepInhibitor();
  const unsubscribeSessions = subscribeSessionChanges((sessions) => {
    if (sessions.length > 0) sleepInhibitor.start();
    else sleepInhibitor.stop();
  });

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    unsubscribeSessions();
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
