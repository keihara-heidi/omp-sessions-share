"use client";

import { Play } from "lucide-react";
import type { WorktreeGroup } from "@/app/components/group-sessions";
import { useLaunchHomeSession, useLaunchSession } from "@/app/components/use-sessions";
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

export function NewHomeSessionButton() {
  const { mutate: launchSession, isPending: isLaunching } =
    useLaunchHomeSession();

  return (
    <TouchButton
      primary
      onClick={() => launchSession()}
      disabled={isLaunching}
      aria-label="Start a new OMP session in your home directory"
    >
      <BusyIcon busy={isLaunching} idle={<Play aria-hidden />} />
      {isLaunching ? "Starting…" : "New session"}
    </TouchButton>
  );
}
