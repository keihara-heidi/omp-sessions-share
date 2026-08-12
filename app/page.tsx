"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { LogOut, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SessionSummary } from "@/lib/contracts";
import { api, ApiError } from "@/app/components/api";
import JoinSession from "@/app/components/join-session";
import {
  NoSessions,
  SessionList,
  SessionSkeletons,
} from "@/app/components/session-list";

export default function DashboardPage() {
  const router = useRouter();
  const [selected, setSelected] = useState<SessionSummary | null>(null);

  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<SessionSummary[]>("/api/sessions"),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const logout = useMutation({
    mutationFn: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSettled: () => router.replace("/login"),
  });

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
        ) : (
          <SessionList
            sessions={sessions.data}
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
