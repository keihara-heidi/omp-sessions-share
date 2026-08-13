"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { SessionSummary } from "@/lib/contracts";
import { api, ApiError, postJson } from "./api";
import { groupSessions, type WorktreeGroup } from "./group-sessions";

const SESSIONS_QUERY_KEY = ["sessions"] as const;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useSessionDashboard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [query, setQuery] = useState("");

  const sessions = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => api<SessionSummary[]>("/api/sessions"),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    const events = new EventSource("/api/events");
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
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
  }, [router, unauthorized]);

  return {
    sessions: sessions.data,
    groups,
    query,
    selected,
    openingId: selected?.id ?? null,
    now: Date.now(),
    unauthorized,
    isPending: sessions.isPending,
    offline: sessions.isError && sessions.data !== undefined,
    failed: sessions.isError && sessions.data === undefined,
    hasSessions: sessions.data !== undefined && sessions.data.length > 0,
    isLoggingOut: logout.isPending,
    setQuery,
    clearQuery: useCallback(() => setQuery(""), []),
    selectSession: useCallback((session: SessionSummary) => setSelected(session), []),
    clearSelected: useCallback(() => setSelected(null), []),
    retry: useCallback(() => void sessions.refetch(), [sessions]),
    logOut: useCallback(() => logout.mutate(), [logout]),
  };
}

export function useLaunchSession(worktree: WorktreeGroup) {
  return useMutation({
    mutationFn: () =>
      api<{ ok: true }>(
        "/api/sessions/launch",
        postJson({ worktreePath: worktree.path }),
      ),
    onSuccess: () => toast.success(`Started OMP in ${worktree.name}`),
    onError: (error) => toast.error(errorMessage(error, "Could not start session")),
  });
}

export function useCreateWorktree(groupPath: string, groupName: string) {
  return useMutation({
    mutationFn: () =>
      api<{ ok: true; path: string }>(
        "/api/sessions/worktrees",
        postJson({ groupPath }),
      ),
    onSuccess: () => toast.success(`Created worktree for ${groupName}`),
    onError: (error) => toast.error(errorMessage(error, "Could not create worktree")),
  });
}

export function useDeactivateSession(session: SessionSummary) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api<{ ok: true }>(
        `/api/sessions/${encodeURIComponent(session.id)}/deactivate`,
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (sessions) =>
        sessions?.filter((item) => item.id !== session.id),
      );
      toast.success("Session removed");
    },
    onError: (error) => toast.error(errorMessage(error, "Could not remove session")),
  });
}
