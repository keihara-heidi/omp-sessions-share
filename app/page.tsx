"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FailAlert, WarnAlert } from "@/components/ds/feedback";
import { Page, PageHeader, PageSearch, PageTitle } from "@/components/ds/page";
import { Button } from "@/components/ui/button";
import type { SessionSummary } from "@/lib/contracts";
import { api, ApiError } from "@/app/components/api";
import { groupSessions } from "@/app/components/group-sessions";
import JoinSession from "@/app/components/join-session";
import { SessionGroups } from "@/app/components/session-groups";
import {
  NoResults,
  NoSessions,
  SessionSkeletons,
} from "@/app/components/session-list";

export default function DashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [query, setQuery] = useState("");

  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<SessionSummary[]>("/api/sessions"),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    const events = new EventSource("/api/events");
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    events.addEventListener("sessions", refresh);
    return () => {
      events.removeEventListener("sessions", refresh);
      events.close();
    };
  }, [queryClient]);

  const logout = useMutation({
    mutationFn: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSettled: () => router.replace("/login"),
  });

  const groups = useMemo(
    () => groupSessions(sessions.data ?? [], query),
    [sessions.data, query],
  );

  const unauthorized =
    sessions.error instanceof ApiError && sessions.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/login");
  }, [unauthorized, router]);
  if (unauthorized) return null;

  const offline = sessions.isError && sessions.data !== undefined;
  const failed = sessions.isError && sessions.data === undefined;
  const now = Date.now();

  return (
    <Page>
      <PageHeader>
        <PageTitle kicker="on this Mac">OMP Sessions</PageTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          <LogOut aria-hidden />
          Log out
        </Button>
      </PageHeader>

      {sessions.data !== undefined && sessions.data.length > 0 && (
        <PageSearch value={query} onChange={setQuery} />
      )}

      {offline && (
        <WarnAlert title="Connection lost">
          Showing the last known sessions. Retrying…
        </WarnAlert>
      )}

      {sessions.isPending && <SessionSkeletons />}

      {failed && (
        <FailAlert
          title="Can't load sessions"
          actionLabel="Try again"
          onAction={() => {
            void sessions.refetch();
          }}
        >
          The server isn&apos;t responding. Check your connection.
        </FailAlert>
      )}

      {sessions.data !== undefined &&
        (sessions.data.length === 0 ? (
          <NoSessions />
        ) : groups.length === 0 ? (
          <NoResults query={query} onClear={() => setQuery("")} />
        ) : (
          <SessionGroups
            groups={groups}
            now={now}
            openingId={selected?.id ?? null}
            onSelect={setSelected}
          />
        ))}

      {selected && (
        <JoinSession session={selected} onDone={() => setSelected(null)} />
      )}
    </Page>
  );
}
