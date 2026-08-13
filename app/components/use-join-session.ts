"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useJoinRequest } from "./use-join-request";

export function useJoinSession(sessionId: string, onDone: () => void): void {
  const phase = useJoinRequest(sessionId);

  useEffect(() => {
    if (phase !== "denied" && phase !== "expired" && phase !== "error") return;

    toast.error(
      phase === "expired"
        ? "Session link timed out. Try again."
        : phase === "denied"
          ? "Session link could not be delivered."
          : "Could not open session.",
    );
    onDone();
  }, [onDone, phase]);
}
