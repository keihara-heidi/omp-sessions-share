"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import type { SessionSummary } from "@/lib/contracts";
import { useJoinRequest } from "./use-join-request";

export default function JoinSession({
  session,
  onDone,
}: {
  session: SessionSummary;
  onDone: () => void;
}) {
  const phase = useJoinRequest(session.id);

  useEffect(() => {
    if (phase !== "denied" && phase !== "expired" && phase !== "error") return;
    const message =
      phase === "expired"
        ? "Session link timed out. Try again."
        : phase === "denied"
          ? "Session link could not be delivered."
          : "Could not open session.";
    toast.error(message);
    onDone();
  }, [onDone, phase]);

  return null;
}
