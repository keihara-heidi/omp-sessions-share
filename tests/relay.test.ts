import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  matchRelayPath,
  relayWebSocket,
  shutdownRelay,
  tryUpgradeRelay,
  type SocketData,
} from "../daemon/relay";

let server: Server<SocketData>;
let base: string;

beforeAll(() => {
  server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      const room = matchRelayPath(url.pathname);
      if (!room) return new Response("not found", { status: 404 });
      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "guest") {
        return new Response("not found", { status: 404 });
      }
      return (
        tryUpgradeRelay(request, bunServer, room.roomId, role) ??
        new Response("websocket upgrade required", { status: 426 })
      );
    },
    websocket: relayWebSocket,
  });
  base = `ws://127.0.0.1:${server.port}`;
});

afterAll(() => {
  shutdownRelay();
  server.stop(true);
});

function opened(socket: WebSocket): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("websocket failed")), {
    once: true,
  });
  return promise;
}

function nextBinaryMessage(socket: WebSocket): Promise<Buffer> {
  const { promise, resolve } = Promise.withResolvers<Buffer>();
  socket.addEventListener(
    "message",
    (event) => {
      if (event.data instanceof ArrayBuffer) resolve(Buffer.from(event.data));
    },
    { once: true },
  );
  return promise;
}

test("routes sealed binary envelopes between host and guest", async () => {
  const room = "test_room_123";
  const host = new WebSocket(`${base}/r/${room}?role=host`);
  host.binaryType = "arraybuffer";
  await opened(host);

  const joined = Promise.withResolvers<string>();
  host.addEventListener(
    "message",
    (event) => {
      if (typeof event.data === "string") joined.resolve(event.data);
    },
    { once: true },
  );
  const guest = new WebSocket(`${base}/r/${room}?role=guest`);
  guest.binaryType = "arraybuffer";
  await opened(guest);
  expect(JSON.parse(await joined.promise)).toEqual({ t: "peer-joined", peer: 1 });

  const broadcast = Buffer.from([0, 0, 0, 0, 7, 8, 9]);
  const guestMessage = nextBinaryMessage(guest);
  host.send(broadcast);
  expect(await guestMessage).toEqual(broadcast);

  const reply = Buffer.from([0, 0, 0, 0, 4, 5, 6]);
  const hostMessage = nextBinaryMessage(host);
  guest.send(reply);
  expect((await hostMessage).readUInt32BE(0)).toBe(1);

  guest.close();
  host.close();
});
