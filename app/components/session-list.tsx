"use client";

import { MonitorOff, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashedEmpty, SessionSkeletonList } from "@/components/ds/feedback";
import { SessionCard } from "@/components/ds/session-card";
import { useDeactivateSession } from "@/app/components/use-sessions";
import type { SessionSummary } from "@/lib/contracts";

/** Shorten a home-rooted absolute path for display. */
export function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function freshness(lastSeenAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(lastSeenAt)) / 1000));
  if (seconds < 5) return "live now";
  if (seconds < 60) return `active ${seconds}s ago`;
  return `active ${Math.round(seconds / 60)}m ago`;
}

export function SessionSkeletons() {
  return <SessionSkeletonList />;
}

export function NoSessions() {
  return (
    <DashedEmpty icon={<MonitorOff aria-hidden />} title="No repositories or folders">
      Start OMP in another terminal. Its location will remain available here.
    </DashedEmpty>
  );
}

export function NoResults({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <DashedEmpty
      icon={<SearchX aria-hidden />}
      title="No matches"
      action={
        <Button variant="outline" size="touch-inline" onClick={onClear}>
          Clear search
        </Button>
      }
    >
      Nothing matches “{query}” across repositories, branches, worktrees, or
      session titles.
    </DashedEmpty>
  );
}

export function SessionButton({
  session,
  now,
  openingId,
  onSelect,
}: {
  session: SessionSummary;
  now: number;
  openingId: string | null;
  onSelect: (session: SessionSummary) => void;
}) {
  const stale = now - Date.parse(session.lastSeenAt) > 15_000;
  const opening = openingId === session.id;
  const deactivate = useDeactivateSession(session);

  return (
    <SessionCard
      stale={stale}
      disabled={openingId !== null || deactivate.isPending}
      busy={opening}
      onSelect={() => onSelect(session)}
      onRemove={() => deactivate.mutate()}
      removeLabel={`Remove ${session.title} from active sessions`}
      removing={deactivate.isPending}
      title={session.title}
      path={tildify(session.cwd)}
      branch={session.worktree.branch}
      meta={freshness(session.lastSeenAt, now)}
    />
  );
}
