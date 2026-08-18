"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  PullRequestAction,
  SessionDashboard,
  WorktreePullRequestStatus,
} from "@/lib/contracts";
import { api, ApiError, postJson } from "./api";
import { groupSessions } from "./group-sessions";

const DASHBOARD_QUERY_KEY = ["sessions"] as const;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function updateDashboard(
  queryClient: QueryClient,
  updater: (dashboard: SessionDashboard) => SessionDashboard,
) {
  queryClient.setQueryData<SessionDashboard>(DASHBOARD_QUERY_KEY, (dashboard) =>
    dashboard ? updater(dashboard) : dashboard,
  );
}

export function useSessionDashboard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const dashboard = useQuery({
    queryKey: DASHBOARD_QUERY_KEY,
    queryFn: () => api<SessionDashboard>("/api/dashboard"),
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    const events = new EventSource("/api/events");
    const onDashboard = (event: MessageEvent<string>) => {
      const { data } = JSON.parse(event.data) as { data: SessionDashboard };
      queryClient.setQueryData(DASHBOARD_QUERY_KEY, data);
    };
    events.addEventListener("dashboard", onDashboard);
    return () => {
      events.removeEventListener("dashboard", onDashboard);
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
        dashboard.data?.recentSessions ?? [],
      ),
    [dashboard.data, query],
  );
  const unauthorized =
    dashboard.error instanceof ApiError && dashboard.error.status === 401;

  useEffect(() => {
    if (unauthorized) router.replace("/login");
  }, [router, unauthorized]);

  return {
    groups,
    query,
    selectedSessionId,
    now: Date.now(),
    unauthorized,
    loaded: dashboard.data !== undefined,
    isPending: dashboard.isPending,
    offline: dashboard.isError && dashboard.data !== undefined,
    failed: dashboard.isError && dashboard.data === undefined,
    hasLocations:
      dashboard.data !== undefined &&
      (dashboard.data.locations.length > 0 ||
        dashboard.data.recentSessions.length > 0),
    isLoggingOut: logout.isPending,
    setQuery,
    clearQuery: () => setQuery(""),
    selectSession: setSelectedSessionId,
    clearSelected: () => setSelectedSessionId(null),
    retry: () => void dashboard.refetch(),
    logOut: () => logout.mutate(),
  };
}

export function useLaunchSession() {
  return useMutation({
    mutationFn: ({
      worktreePath,
      prompt,
    }: {
      worktreePath: string;
      prompt?: string;
    }) =>
      api<{ ok: true }>(
        "/api/sessions/launch",
        postJson({
          worktreePath,
          ...(prompt === undefined ? {} : { prompt }),
        }),
      ),
    onSuccess: () => toast.success("Started OMP session"),
    onError: (error) => toast.error(errorMessage(error, "Could not start session")),
  });
}

/** PR readiness for one worktree; only repository worktrees with a branch query. */
export function usePullRequestStatus(worktreePath: string, enabled: boolean) {
  return useQuery({
    queryKey: ["pull-request", worktreePath],
    queryFn: () =>
      api<WorktreePullRequestStatus>(
        `/api/worktrees/pr?path=${encodeURIComponent(worktreePath)}`,
      ),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useLaunchPullRequestTask() {
  return useMutation({
    mutationFn: ({
      worktreePath,
      action,
    }: {
      worktreePath: string;
      action: PullRequestAction;
    }) =>
      api<{ ok: true }>(
        "/api/worktrees/pr-task",
        postJson({ worktreePath, action }),
      ),
    onSuccess: () => toast.success("Started a PR repair session"),
    onError: (error) =>
      toast.error(errorMessage(error, "Could not start PR repair session")),
  });
}

export function useMergePullRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (worktreePath: string) =>
      api<{ ok: true }>(
        "/api/worktrees/pr-merge",
        postJson({ worktreePath }),
      ),
    onSuccess: (_data, worktreePath) => {
      void queryClient.invalidateQueries({
        queryKey: ["pull-request", worktreePath],
      });
      toast.success("Merged pull request");
    },
    onError: (error) =>
      toast.error(errorMessage(error, "Could not merge pull request")),
  });
}

export function useCreateWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupPath: string) =>
      api<{ ok: true; path: string }>(
        "/api/sessions/worktrees",
        postJson({ groupPath }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
      toast.success("Created worktree");
    },
    onError: (error) => toast.error(errorMessage(error, "Could not create worktree")),
  });
}

export function useDeleteWorktree() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      groupPath,
      worktreePath,
    }: {
      groupPath: string;
      worktreePath: string;
    }) =>
      api<{ ok: true }>("/api/sessions/worktrees", {
        ...postJson({ groupPath, worktreePath }),
        method: "DELETE",
      }),
    onSuccess: (_data, { groupPath, worktreePath }) => {
      updateDashboard(queryClient, (dashboard) => ({
        sessions: dashboard.sessions.filter(
          (session) =>
            session.group.path !== groupPath ||
            session.worktree.path !== worktreePath,
        ),
        locations: dashboard.locations.filter(
          (location) =>
            location.group.path !== groupPath ||
            location.worktree.path !== worktreePath,
        ),
        recentSessions: dashboard.recentSessions.filter(
          (recent) =>
            recent.group.path !== groupPath ||
            recent.worktree.path !== worktreePath,
        ),
      }));
      queryClient.removeQueries({ queryKey: ["pull-request", worktreePath] });
      toast.success("Deleted worktree");
    },
    onError: (error) =>
      toast.error(errorMessage(error, "Could not delete worktree")),
  });
}

export function useDeactivateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api<{ ok: true }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/deactivate`,
        { method: "POST" },
      ),
    onSuccess: (_data, sessionId) => {
      updateDashboard(queryClient, (dashboard) => ({
        ...dashboard,
        sessions: dashboard.sessions.filter((item) => item.id !== sessionId),
      }));
      toast.success("Session removed");
    },
    onError: (error) => toast.error(errorMessage(error, "Could not remove session")),
  });
}

/** Resume a remembered session in its original worktree; the dashboard SSE
 * stream moves it into Live once the daemon reports it — no optimistic move. */
export function useResumeRecentSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (resumeId: string) =>
      api<{ ok: true }>(
        `/api/recent-sessions/${encodeURIComponent(resumeId)}/resume`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
      toast.success("Resuming session");
    },
    onError: (error) =>
      toast.error(errorMessage(error, "Could not resume session")),
  });
}
