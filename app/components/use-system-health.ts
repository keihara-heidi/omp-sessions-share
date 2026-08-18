"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { parseSystemHealth, type SystemHealth } from "@/lib/contracts";
import { api, ApiError } from "./api";

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
