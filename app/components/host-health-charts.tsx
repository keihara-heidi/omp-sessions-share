"use client";

import { useMemo } from "react";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ds/badge";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { TypographyMuted } from "@/components/ui/typography";
import type { HostMetrics } from "@/lib/contracts";

const WINDOW_MS = 15 * 60_000;
const GIB = 2 ** 30;
const CPU_CHART_CONFIG = {
  cpu: { label: "CPU (%)", color: "var(--chart-2)" },
} satisfies ChartConfig;
const MEMORY_CHART_CONFIG = {
  memory: { label: "Memory (GiB)", color: "var(--chart-1)" },
} satisfies ChartConfig;

type SamplePoint = { time: number; cpu: number | null; memory: number };

function MetricChart({
  title,
  ariaLabel,
  currentLabel,
  config,
  dataKey,
  points,
  domain,
  timeDomain,
}: {
  title: string;
  ariaLabel: string;
  currentLabel: string;
  config: ChartConfig;
  dataKey: "cpu" | "memory";
  points: SamplePoint[];
  domain: [number, number];
  timeDomain: [number, number];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <Badge variant="neutral" size="sm">
          {currentLabel}
        </Badge>
      </div>
      {points.length === 0 ? (
        <TypographyMuted>Waiting for the first sample…</TypographyMuted>
      ) : (
        <ChartContainer
          config={config}
          className="aspect-auto h-32 w-full"
          role="img"
          aria-label={ariaLabel}
        >
          <AreaChart
            data={points}
            margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
          >
            <XAxis dataKey="time" type="number" domain={timeDomain} hide />
            <YAxis type="number" domain={domain} hide />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  hideIndicator
                  labelFormatter={(_, payload) => {
                    const point: unknown = payload[0]?.payload;
                    if (
                      point !== null &&
                      typeof point === "object" &&
                      "time" in point &&
                      typeof point.time === "number"
                    ) {
                      return new Date(point.time).toLocaleTimeString();
                    }
                    return "";
                  }}
                />
              }
            />
            <Area
              dataKey={dataKey}
              type="monotone"
              fill={`var(--color-${dataKey})`}
              fillOpacity={0.2}
              stroke={`var(--color-${dataKey})`}
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}

export function HostHealthCharts({ metrics }: { metrics: HostMetrics }) {
  const { points, timeDomain, memoryDomain, cpuLabel, memoryLabel } = useMemo(
    () => {
      const samples: SamplePoint[] = metrics.points.map((point) => ({
        time: Date.parse(point.sampledAt),
        cpu:
          point.cpuPercent === null
            ? null
            : Math.round(point.cpuPercent * 10) / 10,
        memory: Math.round((point.memoryUsedBytes / GIB) * 10) / 10,
      }));
      const last = samples.at(-1);
      const end = last ? last.time : Date.parse(metrics.sampledAt);
      const first = samples[0]?.time ?? end;
      const start = Math.max(end - WINDOW_MS, Math.min(first, end - 60_000));
      const totalGib = metrics.memoryTotalBytes / GIB;
      return {
        points: samples,
        timeDomain: [start, end] as [number, number],
        memoryDomain: [0, totalGib] as [number, number],
        cpuLabel:
          last && last.cpu !== null ? `${last.cpu.toFixed(0)}%` : "—",
        memoryLabel: last
          ? `${last.memory.toFixed(1)} / ${totalGib.toFixed(0)} GiB`
          : "—",
      };
    },
    [metrics],
  );

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <MetricChart
        title="CPU"
        ariaLabel="CPU usage for up to the last 15 minutes"
        currentLabel={cpuLabel}
        config={CPU_CHART_CONFIG}
        dataKey="cpu"
        points={points}
        domain={[0, 100]}
        timeDomain={timeDomain}
      />
      <MetricChart
        title="Memory"
        ariaLabel="Memory usage for up to the last 15 minutes"
        currentLabel={memoryLabel}
        config={MEMORY_CHART_CONFIG}
        dataKey="memory"
        points={points}
        domain={memoryDomain}
        timeDomain={timeDomain}
      />
    </div>
  );
}

export function HostHealthChartSkeletons() {
  return (
    <div aria-hidden className="grid gap-4 md:grid-cols-2">
      {[0, 1].map((item) => (
        <div key={item} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24 max-w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ))}
    </div>
  );
}
