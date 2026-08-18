"use client";

import { useJoinSession } from "./use-join-session";

export default function JoinSession({
  sessionId,
  onDone,
}: {
  sessionId: string;
  onDone: () => void;
}) {
  useJoinSession(sessionId, onDone);
  return null;
}
