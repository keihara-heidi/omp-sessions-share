/** Binary collab WebSocket relay — same protocol as relay/server.ts. */

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
export const MAX_ROOMS = 128;
export const MAX_GUESTS_PER_ROOM = 16;
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export type SocketData = {
  roomId: string;
  role: "host" | "guest";
  peerId: number;
};

type RelaySocket = Bun.ServerWebSocket<SocketData>;

type Room = {
  host: RelaySocket;
  guests: Map<number, RelaySocket>;
  nextPeerId: number;
};

const rooms = new Map<string, Room>();

export function matchRelayPath(pathname: string): { roomId: string } | null {
  const match = ROOM_PATH_RE.exec(pathname);
  if (!match) return null;
  return { roomId: match[1]! };
}

export function tryUpgradeRelay(
  request: Request,
  server: Bun.Server<SocketData>,
  roomId: string,
  role: "host" | "guest",
): Response | undefined {
  if (server.upgrade(request, { data: { roomId, role, peerId: 0 } })) {
    return undefined;
  }
  return new Response("websocket upgrade required", { status: 426 });
}

export const relayWebSocket: Bun.WebSocketHandler<SocketData> = {
  maxPayloadLength: MAX_PAYLOAD_BYTES,
  open(socket) {
    const { roomId, role } = socket.data;
    if (role === "host") {
      if (rooms.has(roomId)) {
        socket.close(4009, "a host is already connected for this room");
        return;
      }
      if (rooms.size >= MAX_ROOMS) {
        socket.close(4013, "relay room capacity reached");
        return;
      }
      rooms.set(roomId, { host: socket, guests: new Map(), nextPeerId: 1 });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      socket.close(4004, "no such room");
      return;
    }
    if (room.guests.size >= MAX_GUESTS_PER_ROOM) {
      socket.close(4013, "room guest capacity reached");
      return;
    }
    const peerId = room.nextPeerId++;
    socket.data.peerId = peerId;
    room.guests.set(peerId, socket);
    room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
  },
  message(socket, message) {
    if (typeof message === "string") return;
    const room = rooms.get(socket.data.roomId);
    if (!room || message.byteLength < 4) return;
    if (socket.data.role === "host") {
      const peerId = message.readUInt32BE(0);
      if (peerId === 0) {
        for (const guest of room.guests.values()) guest.send(message);
      } else {
        room.guests.get(peerId)?.send(message);
      }
      return;
    }
    message.writeUInt32BE(socket.data.peerId, 0);
    room.host.send(message);
  },
  close(socket) {
    const { roomId, role, peerId } = socket.data;
    const room = rooms.get(roomId);
    if (!room) return;
    if (role === "host") {
      if (room.host !== socket) return;
      rooms.delete(roomId);
      for (const guest of room.guests.values()) {
        guest.send(JSON.stringify({ t: "room-closed" }));
        guest.close(4001, "room closed");
      }
      return;
    }
    if (room.guests.delete(peerId)) {
      room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
    }
  },
};

export function shutdownRelay(): void {
  for (const room of rooms.values()) {
    for (const guest of room.guests.values()) {
      guest.close(1001, "relay shutting down");
    }
    room.host.close(1001, "relay shutting down");
  }
  rooms.clear();
}

export function relayRoomCount(): number {
  return rooms.size;
}
