"use client";

import { useMemo, useState } from "react";
import { projectWorkspaces, type SessionGroup } from "@/app/components/group-sessions";
import {
  NoWorkspaceResults,
  NoWorkspaces,
  WorkspaceSkeletons,
} from "@/app/components/workspace-feedback";
import { WorkspaceGroups } from "@/app/components/workspace-groups";
import { useDashboardData } from "@/app/components/use-sessions";
import { FailAlert, WarnAlert } from "@/components/ds/feedback";
import { Page, PageSearch } from "@/components/ds/page";

const EMPTY_GROUPS: SessionGroup[] = [];

export default function WorkspacesPage() {
  const [query, setQuery] = useState("");
  const { data, failed, isPending, loaded, offline, retry, unauthorized } =
    useDashboardData();
  const groups = useMemo(
    () => (data ? projectWorkspaces(data, query) : EMPTY_GROUPS),
    [data, query],
  );
  const hasWorkspaces = Boolean(
    data &&
      (data.locations.length > 0 ||
        data.sessions.length > 0 ||
        data.recentSessions.length > 0),
  );

  if (unauthorized) return null;

  return (
    <Page>
      {hasWorkspaces ? (
        <PageSearch
          value={query}
          onChange={setQuery}
          placeholder="Search repos, worktrees, branches, sessions…"
          ariaLabel="Search workspaces and sessions"
        />
      ) : null}

      {offline ? (
        <WarnAlert title="Connection lost">
          Showing the last known workspaces. Retrying…
        </WarnAlert>
      ) : null}

      {isPending ? <WorkspaceSkeletons /> : null}

      {failed ? (
        <FailAlert
          title="Can't load workspaces"
          actionLabel="Try again"
          onAction={retry}
        >
          The server is not responding. Check your connection.
        </FailAlert>
      ) : null}

      {loaded ? (
        !hasWorkspaces ? (
          <NoWorkspaces />
        ) : groups.length === 0 ? (
          <NoWorkspaceResults query={query} onClear={() => setQuery("")} />
        ) : (
          <WorkspaceGroups groups={groups} query={query} />
        )
      ) : null}
    </Page>
  );
}
