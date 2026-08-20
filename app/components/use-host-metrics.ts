"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { parseHostMetrics, type HostMetrics } from "@/lib/contracts";
import { api } from "./api";

export const HOST_METRICS_QUERY_KEY = ["host-metrics"] as const;

async function fetchHostMetrics(): Promise<HostMetrics> {
  const data = await api<unknown>("/api/system/metrics", {
    cache: "no-store",
  });
  const metrics = parseHostMetrics(data);
  if (!metrics) throw new Error("Malformed host metrics response");
  return metrics;
}

export type HostMetricsStatus = "connecting" | "live" | "stale" | "paused";

/** Initial snapshot via React Query; live 5-second samples via a dedicated
 * SSE stream that replaces the same cache entry. Pausing closes the
 * EventSource locally — daemon sampling continues and reconnect heals gaps
 * because every event carries the full bounded snapshot. */
export function useHostMetrics() {
  const queryClient = useQueryClient();
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);

  const metrics = useQuery({
    queryKey: HOST_METRICS_QUERY_KEY,
    queryFn: fetchHostMetrics,
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    if (paused) return;
    const events = new EventSource("/api/system/metrics/events");
    const onMetrics = (event: MessageEvent<string>) => {
      let body: unknown;
      try {
        body = JSON.parse(event.data);
      } catch {
        return;
      }
      const data =
        body !== null && typeof body === "object" && "data" in body
          ? body.data
          : undefined;
      const snapshot = parseHostMetrics(data);
      if (snapshot) {
        queryClient.setQueryData(HOST_METRICS_QUERY_KEY, snapshot);
        setConnected(true);
      }
    };
    const onOpen = () => setConnected(true);
    const onError = () => setConnected(false);
    events.addEventListener("metrics", onMetrics);
    events.addEventListener("open", onOpen);
    events.addEventListener("error", onError);
    return () => {
      events.removeEventListener("metrics", onMetrics);
      events.removeEventListener("open", onOpen);
      events.removeEventListener("error", onError);
      events.close();
    };
  }, [paused, queryClient]);

  const status: HostMetricsStatus = paused
    ? "paused"
    : connected
      ? "live"
      : metrics.isPending
        ? "connecting"
        : "stale";

  return {
    data: metrics.data,
    isPending: metrics.isPending,
    /** No data at all and the initial fetch failed. */
    failed: metrics.isError && metrics.data === undefined,
    status,
    paused,
    togglePaused: () => setPaused((value) => !value),
    retry: () => void metrics.refetch(),
  };
}
