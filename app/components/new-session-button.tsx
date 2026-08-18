"use client";

import { Play } from "lucide-react";
import type { WorktreeGroup } from "@/app/components/group-sessions";
import { useLaunchSession } from "@/app/components/use-sessions";
import { BusyIcon, TouchButton } from "@/components/ds/session";

export function NewSessionButton({ worktree }: { worktree: WorktreeGroup }) {
  const { mutate: launchSession, isPending: isLaunching } = useLaunchSession();

  return (
    <TouchButton
      wide
      primary
      onClick={() => launchSession({ worktreePath: worktree.path })}
      disabled={isLaunching}
      aria-label={`Start a new OMP session in ${worktree.name}`}
    >
      <BusyIcon busy={isLaunching} idle={<Play aria-hidden />} />
      {isLaunching ? "Starting…" : "New session"}
    </TouchButton>
  );
}
