"use client";

import { FolderCode, MonitorOff } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
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
  onSelect,
}: {
  sessions: SessionSummary[];
  now: number;
  onSelect: (session: SessionSummary) => void;
}) {
  return (
    <ul className="flex list-none flex-col gap-3 p-0">
      {sessions.map((session) => {
        const stale = now - Date.parse(session.lastSeenAt) > 15_000;
        return (
          <li key={session.id}>
            <Item asChild variant="outline" className="cursor-pointer">
              <button
                type="button"
                className="w-full text-left"
                onClick={() => onSelect(session)}
              >
                <ItemContent>
                  <ItemTitle className="w-full">
                    <span
                      aria-hidden
                      data-stale={stale || undefined}
                      className="size-2 shrink-0 rounded-full bg-emerald-500 ring-[3px] ring-emerald-500/25 data-stale:bg-muted-foreground data-stale:ring-0"
                    />
                    <span className="truncate font-medium">
                      {session.title}
                    </span>
                  </ItemTitle>
                  <ItemDescription className="flex w-full items-center gap-1.5 font-mono text-xs">
                    <FolderCode aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate" dir="rtl">
                      <bdi>{session.cwd.replace(/^\/Users\/[^/]+/, "~")}</bdi>
                    </span>
                  </ItemDescription>
                  <ItemDescription className="text-xs">
                    {freshness(session.lastSeenAt, now)}
                  </ItemDescription>
                </ItemContent>
              </button>
            </Item>
          </li>
        );
      })}
    </ul>
  );
}
