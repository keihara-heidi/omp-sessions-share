"use client";

import { MonitorOff, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DashedEmpty, SessionSkeletonList } from "@/components/ds/feedback";
import { SessionCard } from "@/components/ds/session-card";
import { SessionItems } from "@/components/ds/session";
import { TypographySmall } from "@/components/ui/typography";
import {
  useDeactivateSession,
  useResumeRecentSession,
} from "@/app/components/use-sessions";
import type { RecentSessionSummary, SessionSummary } from "@/lib/contracts";
import type { WorktreeGroup } from "@/app/components/group-sessions";

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

function endedAgo(lastSeenAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(lastSeenAt)) / 1000));
  if (seconds < 60) return "ended just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `ended ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `ended ${hours}h ago`;
  return `ended ${Math.round(hours / 24)}d ago`;
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
  onSelect: (sessionId: string) => void;
}) {
  const stale = now - Date.parse(session.lastSeenAt) > 15_000;
  const opening = openingId === session.id;
  const { mutate: deactivateSession, isPending: isDeactivating } =
    useDeactivateSession();

  return (
    <SessionCard
      presence={stale ? "stale" : "live"}
      disabled={openingId !== null || isDeactivating}
      busy={opening}
      onSelect={() => onSelect(session.id)}
      removal={{
        onRemove: () => deactivateSession(session.id),
        label: `Remove ${session.title} from active sessions`,
        removing: isDeactivating,
      }}
      title={session.title}
      path={tildify(session.cwd)}
      branch={session.worktree.branch}
      meta={freshness(session.lastSeenAt, now)}
    />
  );
}

/** Resumable remembered session; no removal rail, no Join — Resume restarts
 * it in its original worktree and SSE moves it to Live. */
export function RecentSessionButton({
  recent,
  now,
  openingId,
}: {
  recent: RecentSessionSummary;
  now: number;
  openingId: string | null;
}) {
  const { mutate: resumeSession, isPending: isResuming } =
    useResumeRecentSession();

  return (
    <SessionCard
      presence="recent"
      disabled={openingId !== null || isResuming}
      busy={isResuming}
      onSelect={() => resumeSession(recent.id)}
      actionLabel="Resume"
      busyLabel="Resuming…"
      title={recent.title}
      path={tildify(recent.worktree.path)}
      branch={recent.worktree.branch}
      meta={endedAgo(recent.lastSeenAt, now)}
    />
  );
}

/** Live/Recent subsection label inside a worktree block. */
function SubsectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2 sm:px-3.5">
      <TypographySmall>{children}</TypographySmall>
    </div>
  );
}

/** Labeled Live/Recent session lists for one worktree. */
export function WorktreeSessionLists({
  worktree,
  now,
  openingId,
  onSelect,
}: {
  worktree: WorktreeGroup;
  now: number;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <>
      {worktree.sessions.length > 0 ? (
        <>
          {worktree.recentSessions.length > 0 ? (
            <SubsectionLabel>Live</SubsectionLabel>
          ) : null}
          <SessionItems>
            {worktree.sessions.map((session) => (
              <li key={session.id}>
                <SessionButton
                  session={session}
                  now={now}
                  openingId={openingId}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </SessionItems>
        </>
      ) : null}
      {worktree.recentSessions.length > 0 ? (
        <>
          <SubsectionLabel>Recent</SubsectionLabel>
          <SessionItems>
            {worktree.recentSessions.map((recent) => (
              <li key={recent.id}>
                <RecentSessionButton
                  recent={recent}
                  now={now}
                  openingId={openingId}
                />
              </li>
            ))}
          </SessionItems>
        </>
      ) : null}
    </>
  );
}
