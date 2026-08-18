"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailAlert, WarnAlert } from "@/components/ds/feedback";
import { Page, PageHeader, PageSearch, PageTitle } from "@/components/ds/page";
import JoinSession from "@/app/components/join-session";
import { SessionGroups } from "@/app/components/session-groups";
import {
  NoResults,
  NoSessions,
  SessionSkeletons,
} from "@/app/components/session-list";
import { useSessionDashboard } from "@/app/components/use-sessions";

export default function DashboardPage() {
  const {
    clearQuery,
    clearSelected,
    failed,
    groups,
    hasLocations,
    isLoggingOut,
    isPending,
    loaded,
    logOut,
    now,
    offline,
    query,
    retry,
    selectedSessionId,
    selectSession,
    setQuery,
    unauthorized,
  } = useSessionDashboard();

  if (unauthorized) return null;

  return (
    <Page>
      <PageHeader>
        <PageTitle kicker="on this Mac">OMP Sessions</PageTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={logOut}
          disabled={isLoggingOut}
          aria-label="Log out"
        >
          <LogOut aria-hidden />
          <span className="hidden sm:inline">Log out</span>
        </Button>
      </PageHeader>

      {hasLocations ? <PageSearch value={query} onChange={setQuery} /> : null}

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
        !hasLocations ? (
          <NoSessions />
        ) : groups.length === 0 ? (
          <NoResults query={query} onClear={clearQuery} />
        ) : (
          <SessionGroups
            groups={groups}
            now={now}
            openingId={selectedSessionId}
            onSelect={selectSession}
          />
        )
      ) : null}

      {selectedSessionId ? (
        <JoinSession sessionId={selectedSessionId} onDone={clearSelected} />
      ) : null}
    </Page>
  );
}
