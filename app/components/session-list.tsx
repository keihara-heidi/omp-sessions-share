"use client";

import { useQueryClient } from "@tanstack/react-query";
import { MonitorOff, SearchX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DashedEmpty } from "@/components/ds/feedback";
import { SessionCard, SessionSkeletonList } from "@/components/ds/session";
import { api } from "@/app/components/api";
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
    <DashedEmpty icon={<MonitorOff aria-hidden />} title="No live sessions">
      Start an OMP session on the Mac and it will show up here within a few
      seconds.
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
        <Button variant="outline" size="sm" onClick={onClear}>
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
  const [deactivating, setDeactivating] = useState(false);
  const queryClient = useQueryClient();

  async function deactivate() {
    setDeactivating(true);
    try {
      await api<{ ok: true }>(
        `/api/sessions/${encodeURIComponent(session.id)}/deactivate`,
        { method: "POST" },
      );
      queryClient.setQueryData<SessionSummary[]>(["sessions"], (sessions) =>
        sessions?.filter((item) => item.id !== session.id),
      );
      toast.success("Session marked inactive");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove session");
    } finally {
      setDeactivating(false);
    }
  }

  return (
    <SessionCard
      stale={stale}
      disabled={openingId !== null || deactivating}
      busy={opening}
      onSelect={() => onSelect(session)}
      onRemove={() => {
        void deactivate();
      }}
      removeLabel={`Remove ${session.title} from active sessions`}
      removing={deactivating}
      title={session.title}
      path={tildify(session.cwd)}
      branch={session.worktree.branch}
      meta={opening ? "Opening…" : freshness(session.lastSeenAt, now)}
    />
  );
}
