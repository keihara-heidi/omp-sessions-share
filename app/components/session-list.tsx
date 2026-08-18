"use client";

import { SessionCard } from "@/components/ds/session-card";
import { SessionItems } from "@/components/ds/session";
import {
  TypographyCount,
  TypographyH2,
  TypographyMuted,
} from "@/components/ui/typography";
import {
  useDeactivateSession,
  useResumeRecentSession,
} from "@/app/components/use-sessions";
import type { RecentSessionSummary, SessionSummary } from "@/lib/contracts";
import type { SessionProjection } from "@/app/components/group-sessions";
import { tildify } from "@/lib/utils";

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

function sessionContext(session: SessionSummary | RecentSessionSummary): string {
  return session.group.name === session.worktree.name
    ? session.group.name
    : `${session.group.name} / ${session.worktree.name}`;
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
      context={sessionContext(session)}
      path={tildify(session.cwd)}
      branch={session.worktree.branch}
      meta={freshness(session.lastSeenAt, now)}
    />
  );
}

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
      context={sessionContext(recent)}
      path={tildify(recent.worktree.path)}
      branch={recent.worktree.branch}
      meta={endedAgo(recent.lastSeenAt, now)}
    />
  );
}

function SectionHeading({
  id,
  title,
  count,
}: {
  id: string;
  title: string;
  count: number;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <TypographyH2 id={id}>{title}</TypographyH2>
      <span className="rounded-md border border-border bg-secondary px-1.5 py-0.5">
        <TypographyCount>{count}</TypographyCount>
      </span>
    </div>
  );
}

export function SessionLists({
  sessions,
  now,
  openingId,
  onSelect,
}: {
  sessions: SessionProjection;
  now: number;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby="live-sessions-heading">
        <SectionHeading
          id="live-sessions-heading"
          title="Live"
          count={sessions.live.length}
        />
        {sessions.live.length > 0 ? (
          <SessionItems>
            {sessions.live.map((session) => (
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
        ) : (
          <TypographyMuted>Nothing is running right now.</TypographyMuted>
        )}
      </section>

      <section aria-labelledby="recent-sessions-heading">
        <SectionHeading
          id="recent-sessions-heading"
          title="Recent"
          count={sessions.recent.length}
        />
        {sessions.recent.length > 0 ? (
          <SessionItems>
            {sessions.recent.map((recent) => (
              <li key={recent.id}>
                <RecentSessionButton
                  recent={recent}
                  now={now}
                  openingId={openingId}
                />
              </li>
            ))}
          </SessionItems>
        ) : (
          <TypographyMuted>No resumable sessions.</TypographyMuted>
        )}
      </section>
    </div>
  );
}
