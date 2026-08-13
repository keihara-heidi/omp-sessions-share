"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CircleMinus, FolderCode, LoaderCircle, MonitorOff, SearchX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
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
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="mt-2 h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function NoSessions() {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MonitorOff aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No live sessions</EmptyTitle>
        <EmptyDescription>
          Start an OMP session on the Mac and it will show up here within a few
          seconds.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
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
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No matches</EmptyTitle>
        <EmptyDescription>
          Nothing matches <span className="font-medium">“{query}”</span> across
          repositories, branches, worktrees, or session titles.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear search
        </Button>
      </EmptyContent>
    </Empty>
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
      await api<{ ok: true }>(`/api/sessions/${encodeURIComponent(session.id)}/deactivate`, {
        method: "POST",
      });
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
    <div className="relative">
      <button
        type="button"
        className="flex w-full touch-manipulation flex-col gap-1.5 rounded-lg border bg-card p-4 pr-12 text-left text-card-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
        onClick={() => onSelect(session)}
        disabled={openingId !== null || deactivating}
        aria-busy={opening}
      >
        <span className="flex w-full items-center gap-2 text-sm font-medium">
          <span
            aria-hidden
            data-stale={stale || undefined}
            className="size-2 shrink-0 rounded-full bg-emerald-500 ring-[3px] ring-emerald-500/25 data-stale:bg-muted-foreground data-stale:ring-0"
          />
          <span className="truncate">{session.title}</span>
        </span>
        <span className="flex w-full items-center gap-1.5 truncate font-mono text-xs text-muted-foreground">
          <FolderCode aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate" dir="rtl">
            <bdi>{tildify(session.cwd)}</bdi>
          </span>
        </span>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {opening ? "Opening…" : freshness(session.lastSeenAt, now)}
        </span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-2 top-2 text-muted-foreground hover:text-destructive"
        onClick={deactivate}
        disabled={deactivating || openingId !== null}
        aria-label={`Remove ${session.title} from active sessions`}
        title="Mark inactive"
      >
        {deactivating ? (
          <LoaderCircle aria-hidden className="animate-spin" />
        ) : (
          <CircleMinus aria-hidden />
        )}
      </Button>
    </div>
  );
}
