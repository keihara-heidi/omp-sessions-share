"use client";

import { useMemo, useState } from "react";
import { FailAlert, WarnAlert } from "@/components/ds/feedback";
import { Page, PageSearch } from "@/components/ds/page";
import JoinSession from "@/app/components/join-session";
import { projectSessions, type SessionProjection } from "@/app/components/group-sessions";
import {
  NoSessionResults,
  NoSessions,
  SessionSkeletons,
} from "@/app/components/session-feedback";
import { SessionLists } from "@/app/components/session-list";
import { useDashboardData } from "@/app/components/use-sessions";

const EMPTY_SESSIONS: SessionProjection = { live: [], recent: [] };

export default function SessionsPage() {
  const [query, setQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const { data, failed, isPending, loaded, offline, retry, unauthorized } =
    useDashboardData();
  const sessions = useMemo(
    () => (data ? projectSessions(data, query) : EMPTY_SESSIONS),
    [data, query],
  );
  const hasSessions = Boolean(
    data && (data.sessions.length > 0 || data.recentSessions.length > 0),
  );
  const hasResults = sessions.live.length > 0 || sessions.recent.length > 0;

  if (unauthorized) return null;

  return (
    <Page>
      {hasSessions ? (
        <PageSearch
          value={query}
          onChange={setQuery}
          placeholder="Search sessions, repos, worktrees…"
          ariaLabel="Search sessions"
        />
      ) : null}

      {offline ? (
        <WarnAlert title="Connection lost">
          Showing the last known sessions. Retrying…
        </WarnAlert>
      ) : null}

      {isPending ? <SessionSkeletons /> : null}

      {failed ? (
        <FailAlert
          title="Can't load sessions"
          actionLabel="Try again"
          onAction={retry}
        >
          The server is not responding. Check your connection.
        </FailAlert>
      ) : null}

      {loaded ? (
        !hasSessions ? (
          <NoSessions />
        ) : !hasResults ? (
          <NoSessionResults query={query} onClear={() => setQuery("")} />
        ) : (
          <SessionLists
            sessions={sessions}
            now={Date.now()}
            openingId={selectedSessionId}
            onSelect={setSelectedSessionId}
          />
        )
      ) : null}

      {selectedSessionId ? (
        <JoinSession
          sessionId={selectedSessionId}
          onDone={() => setSelectedSessionId(null)}
        />
      ) : null}
    </Page>
  );
}
