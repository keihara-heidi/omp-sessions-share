"use client";

import type { SessionSummary } from "@/lib/contracts";
import { useJoinSession } from "./use-join-session";

export default function JoinSession({
  session,
  onDone,
}: {
  session: SessionSummary;
  onDone: () => void;
}) {
  useJoinSession(session.id, onDone);
  return null;
}
