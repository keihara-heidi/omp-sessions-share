/** In-process local-host CPU/memory sampler for the dashboard. */

import {
  cpus as osCpus,
  freemem as osFreemem,
  hostname as osHostname,
  totalmem as osTotalmem,
} from "node:os";
import type { HostMetrics, HostMetricsPoint } from "../lib/contracts";

export const HOST_METRICS_MAX_POINTS = 180;
export const HOST_METRICS_SAMPLE_MS = 5_000;

export type CpuTimesSnapshot = {
  idle: number;
  total: number;
};

export type HostMetricsSource = {
  nowIso: () => string;
  hostname: () => string;
  totalmem: () => number;
  /** App/anonymous + wired + compressed bytes, matching Activity Monitor. */
  memoryUsed: () => number;
  /** Summed cumulative idle/total ticks across cores. */
  cpuTimes: () => CpuTimesSnapshot;
};

export type SystemMetricsServiceOptions = {
  sampleIntervalMs?: number;
  maxPoints?: number;
  source?: Partial<HostMetricsSource>;
  /** When false, timer is not started; call `sample` manually. Default true. */
  autoStart?: boolean;
};

export type SystemMetricsService = {
  getMetrics: () => HostMetrics;
  subscribe: (listener: (metrics: HostMetrics) => void) => () => void;
  /** Take one sample immediately (test seam). */
  sample: () => HostMetrics;
  stop: () => void;
};

function defaultCpuTimes(): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of osCpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Parse the three resident categories used by macOS Activity Monitor. */
export function parseVmStatMemoryUsed(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const anonymous = /^Anonymous pages:\s+(\d+)\.?$/m.exec(output)?.[1];
  const wired = /^Pages wired down:\s+(\d+)\.?$/m.exec(output)?.[1];
  const compressed =
    /^Pages occupied by compressor:\s+(\d+)\.?$/m.exec(output)?.[1];
  if (!pageSize || !anonymous || !wired || !compressed) return null;
  const used =
    (Number(anonymous) + Number(wired) + Number(compressed)) * Number(pageSize);
  return Number.isSafeInteger(used) && used >= 0 ? used : null;
}

function defaultMemoryUsed(): number {
  const result = Bun.spawnSync(["/usr/bin/vm_stat"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode === 0) {
    const used = parseVmStatMemoryUsed(result.stdout.toString());
    if (used !== null) return used;
  }
  return osTotalmem() - osFreemem();
}

function defaultSource(): HostMetricsSource {
  return {
    nowIso: () => new Date().toISOString(),
    hostname: () => osHostname(),
    totalmem: () => osTotalmem(),
    memoryUsed: defaultMemoryUsed,
    cpuTimes: defaultCpuTimes,
  };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Export for focused delta-math unit tests. */
export function computeCpuPercent(
  prev: CpuTimesSnapshot,
  next: CpuTimesSnapshot,
): number | null {
  const idleDelta = next.idle - prev.idle;
  const totalDelta = next.total - prev.total;
  if (!(totalDelta > 0) || idleDelta < 0 || idleDelta > totalDelta) {
    return null;
  }
  return clamp((1 - idleDelta / totalDelta) * 100, 0, 100);
}

export function createSystemMetricsService(
  options: SystemMetricsServiceOptions = {},
): SystemMetricsService {
  const maxPoints = options.maxPoints ?? HOST_METRICS_MAX_POINTS;
  const intervalMs = options.sampleIntervalMs ?? HOST_METRICS_SAMPLE_MS;
  const source: HostMetricsSource = { ...defaultSource(), ...options.source };

  const listeners = new Set<(metrics: HostMetrics) => void>();
  const points: HostMetricsPoint[] = [];
  let prevCpu: CpuTimesSnapshot | null = null;
  let memoryTotalBytes = 0;
  let hostName = source.hostname();
  let sampledAt = source.nowIso();
  let timer: ReturnType<typeof setInterval> | undefined;

  function snapshot(): HostMetrics {
    return {
      hostName,
      sampledAt,
      memoryTotalBytes,
      points: points.slice(),
    };
  }

  function sample(): HostMetrics {
    hostName = source.hostname();
    const total = Math.max(0, Math.floor(source.totalmem()));
    const used = clamp(Math.floor(source.memoryUsed()), 0, total);
    memoryTotalBytes = total;
    const now = source.nowIso();
    const cpu = source.cpuTimes();

    let cpuPercent: number | null = null;
    if (prevCpu !== null) {
      cpuPercent = computeCpuPercent(prevCpu, cpu);
    }
    prevCpu = cpu;

    points.push({
      sampledAt: now,
      cpuPercent,
      memoryUsedBytes: used,
    });
    while (points.length > maxPoints) points.shift();
    sampledAt = now;

    const metrics = snapshot();
    for (const listener of listeners) {
      try {
        listener(metrics);
      } catch {
        // ignore listener errors
      }
    }
    return metrics;
  }

  // Immediate baseline sample: first published point may have null CPU.
  sample();

  if (options.autoStart !== false) {
    timer = setInterval(() => {
      sample();
    }, intervalMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      timer.unref();
    }
  }

  return {
    getMetrics: () => snapshot(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sample,
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      listeners.clear();
    },
  };
}
