"use client";

import { Activity, Pause, Play, RefreshCw } from "lucide-react";
import {
  HostHealthCharts,
  HostHealthChartSkeletons,
} from "@/app/components/host-health-charts";
import { Badge, type BadgeVariant } from "@/components/ds/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { TypographyH2, TypographyMuted } from "@/components/ui/typography";
import {
  useHostMetrics,
  type HostMetricsStatus,
} from "@/app/components/use-host-metrics";

const STATUS_META: Record<
  HostMetricsStatus,
  { label: string; variant: BadgeVariant }
> = {
  connecting: { label: "Connecting", variant: "neutral" },
  live: { label: "Live", variant: "success" },
  stale: { label: "Stale", variant: "warning" },
  paused: { label: "Paused", variant: "neutral" },
};


export function HostHealthSection() {
  const { data, isPending, failed, status, paused, togglePaused, retry } =
    useHostMetrics();
  const statusMeta = STATUS_META[status];

  return (
    <section aria-labelledby="system-host-heading">
      <Card size="sm">
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <TypographyH2 id="system-host-heading">Host health</TypographyH2>
            <Badge variant={statusMeta.variant} size="md">
              <Activity aria-hidden />
              {statusMeta.label}
            </Badge>
          </div>
          <CardDescription>
            {data
              ? `${data.hostName} · CPU and memory, up to 15 minutes`
              : "CPU and memory, up to 15 minutes"}
          </CardDescription>
          <CardAction>
            <Button
              variant="outline"
              size="touch-inline"
              onClick={togglePaused}
              aria-pressed={paused}
            >
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {paused ? "Resume" : "Pause"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {isPending ? <HostHealthChartSkeletons /> : null}
          {failed ? (
            <div className="flex flex-col items-start gap-2">
              <TypographyMuted>
                Can&apos;t load host metrics. The server is not responding.
              </TypographyMuted>
              <Button variant="outline" size="touch-inline" onClick={retry}>
                <RefreshCw aria-hidden />
                Try again
              </Button>
            </div>
          ) : null}
          {data ? <HostHealthCharts metrics={data} /> : null}
        </CardContent>
      </Card>
    </section>
  );
}
