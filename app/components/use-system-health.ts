"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  parsePluginUpdateStatus,
  parseSystemHealth,
  type PluginUpdateStatus,
  type SystemHealth,
} from "@/lib/contracts";
import { api, ApiError, postJson } from "./api";

export const SYSTEM_HEALTH_QUERY_KEY = ["system-health"] as const;

async function fetchSystemHealth(): Promise<SystemHealth> {
  const data = await api<unknown>("/api/system/health", { cache: "no-store" });
  const health = parseSystemHealth(data);
  if (!health) throw new Error("Malformed system health response");
  return health;
}

/** Independent of the dashboard SSE stream — health refreshes on focus/manual retry only. */
export function useSystemHealth() {
  const router = useRouter();
  const health = useQuery({
    queryKey: SYSTEM_HEALTH_QUERY_KEY,
    queryFn: fetchSystemHealth,
    staleTime: 20_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const unauthorized =
    health.error instanceof ApiError && health.error.status === 401;

  useEffect(() => {
    if (unauthorized) router.replace("/login");
  }, [router, unauthorized]);

  return {
    data: health.data,
    unauthorized,
    loaded: health.data !== undefined,
    isPending: health.isPending,
    isFetching: health.isFetching,
    offline: health.isError && health.data !== undefined,
    failed: health.isError && health.data === undefined,
    retry: () => void health.refetch(),
  };
}

export function useCheckPluginUpdate() {
  return useMutation({
    mutationFn: async (): Promise<PluginUpdateStatus> => {
      const data = await api<unknown>("/api/system/update/check", {
        method: "POST",
      });
      const status = parsePluginUpdateStatus(data);
      if (!status) throw new Error("Malformed update status response");
      return status;
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not check for updates"),
  });
}

export function useUpdatePlugin() {
  return useMutation({
    mutationFn: (commit: string) =>
      api<{ ok: true }>("/api/system/update", postJson({ commit })),
    onSuccess: () =>
      toast.success("Update started. The dashboard will reconnect after restarting."),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not start update"),
  });
}
