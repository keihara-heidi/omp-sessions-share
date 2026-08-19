"use client";

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { SessionCard } from "@/components/ds/session-card";
import { SessionItems } from "@/components/ds/session";
import { Badge } from "@/components/ds/badge";
import { TypographyH2, TypographyMuted } from "@/components/ui/typography";
import { useDeactivateSession, useDeleteRecentSession, useResumeRecentSession } from "@/app/components/use-sessions";
import type { RecentSessionSummary, SessionSummary } from "@/lib/contracts";
import type { SessionProjection } from "@/app/components/group-sessions";
import { tildify } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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
  onSelect,
}: {
  recent: RecentSessionSummary;
  now: number;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const { mutate: deleteSession, isPending: isDeleting } =
    useDeleteRecentSession();
  const { mutateAsync: resumeSession, isPending: isResuming } =
    useResumeRecentSession();

  return (
    <SessionCard
      presence="recent"
      disabled={openingId !== null || isResuming || isDeleting}
      busy={isResuming}
      onSelect={async () => {
        try {
          await resumeSession(recent.id);
          onSelect(recent.id);
        } catch {
          // The mutation already reports resume failures.
        }
      }}
      actionLabel="Resume"
      busyLabel="Resuming…"
      title={recent.title}
      removal={{
        onRemove: () => deleteSession(recent.id),
        label: `Remove ${recent.title} from recent sessions`,
        removing: isDeleting,
        title: "Forget session",
      }}
      context={sessionContext(recent)}
      path={tildify(recent.worktree.path)}
      branch={recent.worktree.branch}
      meta={endedAgo(recent.lastSeenAt, now)}
    />
  );
}

function SessionSection({ title, count, children }: {
  title: "Live" | "Recent";
  count: number;
  children: ReactNode;
}) {
  const id = `${title.toLowerCase()}-sessions-heading`;
  return (
    <section aria-labelledby={id}>
      <Collapsible defaultOpen={title === "Live"}>
        <div className="mb-2">
          <TypographyH2 id={id}>
            <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight aria-hidden className="size-4 shrink-0 text-dim transition-transform group-data-[state=open]:rotate-90" />
              <span className="flex-1">{title}</span>
              <Badge variant="neutral" size="xs">{count}</Badge>
            </CollapsibleTrigger>
          </TypographyH2>
        </div>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
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
      <SessionSection title="Live" count={sessions.live.length}>
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
      </SessionSection>

      <SessionSection title="Recent" count={sessions.recent.length}>
        {sessions.recent.length > 0 ? (
          <SessionItems>
            {sessions.recent.map((recent) => (
              <li key={recent.id}>
                <RecentSessionButton
                  recent={recent}
                  now={now}
                  openingId={openingId}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </SessionItems>
        ) : (
          <TypographyMuted>No resumable sessions.</TypographyMuted>
        )}
      </SessionSection>
    </div>
  );
}
