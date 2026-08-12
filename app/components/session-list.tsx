"use client";

import { FolderCode, MonitorOff } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionSummary } from "@/lib/contracts";

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

export function SessionList({
  sessions,
  now,
  openingId,
  onSelect,
}: {
  sessions: SessionSummary[];
  now: number;
  openingId: string | null;
  onSelect: (session: SessionSummary) => void;
}) {
  return (
    <ul className="flex list-none flex-col gap-3 p-0">
      {sessions.map((session) => {
        const stale = now - Date.parse(session.lastSeenAt) > 15_000;
        const opening = openingId === session.id;
        return (
          <li key={session.id}>
            <button
              type="button"
              className="flex w-full touch-manipulation flex-col gap-1.5 rounded-lg border bg-card p-4 text-left text-card-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
              onClick={() => onSelect(session)}
              disabled={openingId !== null}
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
                  <bdi>{session.cwd.replace(/^\/Users\/[^/]+/, "~")}</bdi>
                </span>
              </span>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {opening ? "Opening…" : freshness(session.lastSeenAt, now)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
