"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Search, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
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
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-6 sm:pt-10">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">
          OMP Sessions{" "}
          <span className="font-normal text-muted-foreground">
            on this Mac
          </span>
        </h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          <LogOut aria-hidden />
          Log out
        </Button>
      </header>

      {sessions.data !== undefined && sessions.data.length > 0 && (
        <InputGroup className="mb-6">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            placeholder="Search repos, branches, worktrees, sessions…"
            aria-label="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </InputGroup>
      )}

      {offline && (
        <Alert className="mb-4 border-amber-500/40 bg-amber-500/10 text-amber-500 [&>svg]:text-amber-500">
          <WifiOff aria-hidden />
          <AlertTitle>Connection lost</AlertTitle>
          <AlertDescription className="text-amber-500/80">
            Showing the last known sessions. Retrying…
          </AlertDescription>
        </Alert>
      )}

      {sessions.isPending && <SessionSkeletons />}

      {failed && (
        <Alert variant="destructive">
          <WifiOff aria-hidden />
          <AlertTitle>Can&apos;t load sessions</AlertTitle>
          <AlertDescription>
            <p>The server isn&apos;t responding. Check your connection.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => sessions.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
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
    </main>
  );
}
