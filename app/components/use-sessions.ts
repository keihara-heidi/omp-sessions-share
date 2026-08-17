"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  PullRequestAction,
  SessionDashboard,
  SessionSummary,
  WorktreePullRequestStatus,
} from "@/lib/contracts";
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

  const dashboard = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => api<SessionDashboard>("/api/dashboard"),
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    const events = new EventSource("/api/events");
    const updateDashboard = (event: MessageEvent<string>) => {
      const { data } = JSON.parse(event.data) as { data: SessionDashboard };
      queryClient.setQueryData(SESSIONS_QUERY_KEY, data);
    };
    events.addEventListener("dashboard", updateDashboard);
    return () => {
      events.removeEventListener("dashboard", updateDashboard);
      events.close();
    };
  }, [queryClient]);

  const logout = useMutation({
    mutationFn: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSettled: () => router.replace("/login"),
  });

  const groups = useMemo(
    () =>
      groupSessions(
        dashboard.data?.sessions ?? [],
        query,
        dashboard.data?.locations ?? [],
      ),
    [dashboard.data, query],
  );
  const unauthorized =
    dashboard.error instanceof ApiError && dashboard.error.status === 401;

  useEffect(() => {
    if (unauthorized) router.replace("/login");
  }, [router, unauthorized]);

  return {
    sessions: dashboard.data?.sessions,
    locations: dashboard.data?.locations,
    groups,
    query,
    selected,
    openingId: selected?.id ?? null,
    now: Date.now(),
    unauthorized,
    isPending: dashboard.isPending,
    offline: dashboard.isError && dashboard.data !== undefined,
    failed: dashboard.isError && dashboard.data === undefined,
    hasLocations:
      dashboard.data !== undefined && dashboard.data.locations.length > 0,
    isLoggingOut: logout.isPending,
    setQuery,
    clearQuery: useCallback(() => setQuery(""), []),
    selectSession: useCallback((session: SessionSummary) => setSelected(session), []),
    clearSelected: useCallback(() => setSelected(null), []),
    retry: useCallback(() => void dashboard.refetch(), [dashboard]),
    logOut: useCallback(() => logout.mutate(), [logout]),
  };
}

export function useLaunchSession(worktree: WorktreeGroup) {
  return useMutation({
    mutationFn: (prompt?: string) =>
      api<{ ok: true }>(
        "/api/sessions/launch",
        postJson({
          worktreePath: worktree.path,
          ...(prompt === undefined ? {} : { prompt }),
        }),
      ),
    onSuccess: () => toast.success(`Started OMP in ${worktree.name}`),
    onError: (error) => toast.error(errorMessage(error, "Could not start session")),
  });
}

/** PR readiness for one worktree; only repository worktrees with a branch query. */
export function usePullRequestStatus(worktree: WorktreeGroup, enabled: boolean) {
  return useQuery({
    queryKey: ["pull-request", worktree.path],
    queryFn: () =>
      api<WorktreePullRequestStatus>(
        `/api/worktrees/pr?path=${encodeURIComponent(worktree.path)}`,
      ),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useLaunchPullRequestTask(worktree: WorktreeGroup) {
  return useMutation({
    mutationFn: (action: PullRequestAction) =>
      api<{ ok: true }>(
        "/api/worktrees/pr-task",
        postJson({ worktreePath: worktree.path, action }),
      ),
    onSuccess: () => toast.success("Started a PR repair session"),
    onError: (error) =>
      toast.error(errorMessage(error, "Could not start PR repair session")),
  });
}

export function useMergePullRequest(worktree: WorktreeGroup) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ ok: true }>(
        "/api/worktrees/pr-merge",
        postJson({ worktreePath: worktree.path }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pull-request", worktree.path] });
      toast.success("Merged pull request");
    },
    onError: (error) =>
      toast.error(errorMessage(error, "Could not merge pull request")),
  });
}

export function useCreateWorktree(groupPath: string, groupName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ ok: true; path: string }>(
        "/api/sessions/worktrees",
        postJson({ groupPath }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      toast.success(`Created worktree for ${groupName}`);
    },
    onError: (error) => toast.error(errorMessage(error, "Could not create worktree")),
  });
}

export function useDeleteWorktree(
  groupPath: string,
  groupName: string,
  worktree: WorktreeGroup,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api<{ ok: true }>("/api/sessions/worktrees", {
        ...postJson({ groupPath, worktreePath: worktree.path }),
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.setQueryData<SessionDashboard>(SESSIONS_QUERY_KEY, (dashboard) =>
        dashboard
          ? {
              sessions: dashboard.sessions.filter(
                (session) =>
                  session.group.path !== groupPath ||
                  session.worktree.path !== worktree.path,
              ),
              locations: dashboard.locations.filter(
                (location) =>
                  location.group.path !== groupPath ||
                  location.worktree.path !== worktree.path,
              ),
            }
          : dashboard,
      );
      queryClient.removeQueries({ queryKey: ["pull-request", worktree.path] });
      toast.success(`Deleted ${worktree.name} from ${groupName}`);
    },
    onError: (error) =>
      toast.error(errorMessage(error, "Could not delete worktree")),
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
      queryClient.setQueryData<SessionDashboard>(SESSIONS_QUERY_KEY, (dashboard) =>
        dashboard
          ? {
              ...dashboard,
              sessions: dashboard.sessions.filter((item) => item.id !== session.id),
            }
          : dashboard,
      );
      toast.success("Session removed");
    },
    onError: (error) => toast.error(errorMessage(error, "Could not remove session")),
  });
}
