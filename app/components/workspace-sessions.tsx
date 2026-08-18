"use client";

import { CircleMinus, LoaderCircle } from "lucide-react";
import type { SessionSummary } from "@/lib/contracts";
import type { WorktreeGroup } from "@/app/components/group-sessions";
import { useDeactivateSession } from "@/app/components/use-sessions";
import { Badge } from "@/components/ds/badge";
import { Button } from "@/components/ui/button";

export function WorkspaceCounts({ worktree }: { worktree: WorktreeGroup }) {
  return (
    <span className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
      <span className="sm:w-20">
        <Badge variant="success" size="md" stretch>
          {worktree.sessions.length} Live
        </Badge>
      </span>
      <span className="sm:w-20">
        <Badge variant="neutral" size="md" stretch>
          {worktree.recentSessions.length} Recent
        </Badge>
      </span>
    </span>
  );
}

function LiveSessionRow({
  session,
  openingId,
  onSelect,
}: {
  session: SessionSummary;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const opening = openingId === session.id;
  const { mutate: deactivateSession, isPending: isDeactivating } =
    useDeactivateSession();

  return (
    <li className="flex min-h-11 min-w-0 items-stretch">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 text-left transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
        onClick={() => onSelect(session.id)}
        disabled={openingId !== null || isDeactivating}
        aria-busy={opening}
        aria-label={`Join ${session.title}`}
      >
        <span
          className="min-w-0 flex-1 truncate text-xs text-foreground"
          title={session.title}
        >
          {session.title}
        </span>
        <span className="w-20 shrink-0">
          <Badge variant={opening ? "info" : "success"} size="xs" stretch>
            {opening ? "Opening…" : "Live"}
          </Badge>
        </span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-auto min-h-11 min-w-11 rounded-l-none text-dim hover:bg-destructive/10 hover:text-destructive"
        onClick={() => deactivateSession(session.id)}
        disabled={openingId !== null || isDeactivating}
        aria-label={`Remove ${session.title} from active sessions`}
        title="Mark inactive"
      >
        {isDeactivating ? (
          <LoaderCircle aria-hidden className="animate-spin" />
        ) : (
          <CircleMinus aria-hidden />
        )}
      </Button>
    </li>
  );
}

export function WorkspaceSessions({
  worktree,
  openingId,
  onSelect,
}: {
  worktree: WorktreeGroup;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  if (worktree.sessions.length === 0 && worktree.recentSessions.length === 0) {
    return null;
  }

  return (
    <div
      className="border-t border-border px-3 py-2"
      aria-label={`Sessions in ${worktree.name}`}
    >
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {worktree.sessions.map((session) => (
          <LiveSessionRow
            key={session.id}
            session={session}
            openingId={openingId}
            onSelect={onSelect}
          />
        ))}
        {worktree.recentSessions.map((session) => (
          <li
            key={session.id}
            className="flex min-h-11 min-w-0 items-center gap-2 px-2"
          >
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={session.title}
            >
              {session.title}
            </span>
            <span className="w-20 shrink-0">
              <Badge variant="neutral" size="xs" stretch>Recent</Badge>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
