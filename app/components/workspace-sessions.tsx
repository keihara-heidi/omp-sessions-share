"use client";

import { CircleMinus, LoaderCircle } from "lucide-react";
import type { RecentSessionSummary, SessionSummary } from "@/lib/contracts";
import type { WorktreeGroup } from "@/app/components/group-sessions";
import {
  useDeactivateSession,
  useResumeRecentSession,
} from "@/app/components/use-sessions";
import { Badge } from "@/components/ds/badge";
import { Button } from "@/components/ui/button";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function WorkspaceCounts({ worktree }: { worktree: WorktreeGroup }) {
  return (
    <TabsList aria-label={`Sessions in ${worktree.name}`} className="grid w-full grid-cols-2 sm:w-auto">
      <TabsTrigger value="live" className="sm:w-20">
        {worktree.sessions.length} Live
      </TabsTrigger>
      <TabsTrigger value="recent" className="sm:w-20">
        {worktree.recentSessions.length} Recent
      </TabsTrigger>
    </TabsList>
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

function RecentSessionRow({
  session,
  openingId,
  onSelect,
}: {
  session: RecentSessionSummary;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const { mutateAsync: resumeSession, isPending: isResuming } =
    useResumeRecentSession();

  return (
    <li className="flex min-h-11 min-w-0 items-stretch">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
        onClick={async () => {
          try {
            await resumeSession(session.id);
            onSelect(session.id);
          } catch {
            // The mutation already reports resume failures.
          }
        }}
        disabled={openingId !== null || isResuming}
        aria-busy={isResuming}
        aria-label={`Resume ${session.title}`}
      >
        <span
          className="min-w-0 flex-1 truncate text-xs text-foreground"
          title={session.title}
        >
          {session.title}
        </span>
        <span className="w-20 shrink-0">
          <Badge variant={isResuming ? "info" : "neutral"} size="xs" stretch>
            {isResuming ? "Resuming…" : "Resume"}
          </Badge>
        </span>
      </button>
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
  const panelClassName = "border-t border-border px-3 py-2";

  return (
    <>
      <TabsContent value="live" className={panelClassName}>
        {worktree.sessions.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {worktree.sessions.map((session) => (
              <LiveSessionRow
                key={session.id}
                session={session}
                openingId={openingId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No live sessions.</p>
        )}
      </TabsContent>
      <TabsContent value="recent" className={panelClassName}>
        {worktree.recentSessions.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {worktree.recentSessions.map((session) => (
              <RecentSessionRow
                key={session.id}
                session={session}
                openingId={openingId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No recent sessions.</p>
        )}
      </TabsContent>
    </>
  );
}
