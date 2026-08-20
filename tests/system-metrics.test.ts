import { afterEach, describe, expect, test } from "bun:test";
import type { ShareConfig } from "../shared/config";
import { handleApi } from "../daemon/api";
import {
  computeCpuPercent,
  createSystemMetricsService,
  HOST_METRICS_MAX_POINTS,
  parseVmStatMemoryUsed,
  type CpuTimesSnapshot,
  type SystemMetricsService,
} from "../daemon/system-metrics";
import { DASHBOARD_COOKIE_NAME } from "../lib/auth";
import {
  parseHostMetrics,
  type HostMetrics,
  type HostMetricsPoint,
} from "../lib/contracts";
const config: ShareConfig = {
  version: 1,
  localOrigin: "http://127.0.0.1:7466",
  publicOrigin: "https://host.example.ts.net:8443",
  hostToken: "host-token-long-enough",
  dashboardPassword: "dashboard-password",
  cookieSecret: "cookie-secret-long-enough",
};

const services: SystemMetricsService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
});

function track(service: SystemMetricsService): SystemMetricsService {
  services.push(service);
  return service;
}

function point(
  sampledAt: string,
  cpuPercent: number | null,
  memoryUsedBytes: number,
): HostMetricsPoint {
  return { sampledAt, cpuPercent, memoryUsedBytes };
}

function validMetrics(
  overrides: Partial<HostMetrics> = {},
): HostMetrics {
  const points =
    overrides.points ??
    [
      point("2026-08-20T12:00:00.000Z", null, 1_000),
      point("2026-08-20T12:00:05.000Z", 12.5, 2_000),
    ];
  return {
    hostName: "dev-host",
    sampledAt: points.length
      ? points[points.length - 1]!.sampledAt
      : "2026-08-20T12:00:00.000Z",
    memoryTotalBytes: 8_000,
    points,
    ...overrides,
    ...(overrides.points
      ? {
          sampledAt:
            overrides.sampledAt ??
            (overrides.points.length
              ? overrides.points[overrides.points.length - 1]!.sampledAt
              : "2026-08-20T12:00:00.000Z"),
        }
      : {}),
  };
}

async function loginCookie(
  password = config.dashboardPassword,
): Promise<string> {
  const res = await handleApi(
    new Request("http://local/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
    config,
    "/api/auth/login",
  );
  if (!res || res.status !== 200) throw new Error("login failed");
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${DASHBOARD_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  if (!match) throw new Error("missing dashboard cookie");
  return `${DASHBOARD_COOKIE_NAME}=${match[1]}`;
}

describe("parseHostMetrics", () => {
  test("accepts a bounded ascending snapshot", () => {
    const metrics = validMetrics();
    expect(parseHostMetrics(metrics)).toEqual(metrics);
  });

  test("rejects malformed envelopes and out-of-bounds values", () => {
    expect(parseHostMetrics(null)).toBeNull();
    expect(parseHostMetrics([])).toBeNull();
    expect(parseHostMetrics(validMetrics({ hostName: "" }))).toBeNull();
    expect(
      parseHostMetrics(validMetrics({ sampledAt: "not-a-timestamp" })),
    ).toBeNull();
    expect(
      parseHostMetrics(validMetrics({ memoryTotalBytes: -1 })),
    ).toBeNull();
    expect(
      parseHostMetrics(
        validMetrics({
          points: [point("2026-08-20T12:00:00.000Z", 101, 1)],
        }),
      ),
    ).toBeNull();
    expect(
      parseHostMetrics(
        validMetrics({
          points: [point("2026-08-20T12:00:00.000Z", -0.1, 1)],
        }),
      ),
    ).toBeNull();
    expect(
      parseHostMetrics(
        validMetrics({
          memoryTotalBytes: 100,
          points: [point("2026-08-20T12:00:00.000Z", 1, 101)],
        }),
      ),
    ).toBeNull();
    expect(
      parseHostMetrics(
        validMetrics({
          points: [
            point("2026-08-20T12:00:05.000Z", null, 1),
            point("2026-08-20T12:00:00.000Z", 1, 1),
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseHostMetrics(
        validMetrics({
          points: [
            point("2026-08-20T12:00:00.000Z", null, 1),
            point("2026-08-20T12:00:00.000Z", 1, 1),
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseHostMetrics(
        validMetrics({
          sampledAt: "2026-08-20T12:00:00.000Z",
          points: [point("2026-08-20T12:00:05.000Z", 1, 1)],
        }),
      ),
    ).toBeNull();

    const tooMany: HostMetricsPoint[] = [];
    for (let i = 0; i < HOST_METRICS_MAX_POINTS + 1; i++) {
      tooMany.push(
        point(
          new Date(Date.UTC(2026, 7, 20, 12, 0, i)).toISOString(),
          i === 0 ? null : 1,
          1,
        ),
      );
    }
    expect(parseHostMetrics(validMetrics({ points: tooMany }))).toBeNull();
  });
});

describe("computeCpuPercent", () => {
  test("uses cumulative idle/total deltas and clamps to 0..100", () => {
    const prev: CpuTimesSnapshot = { idle: 100, total: 200 };
    const halfBusy: CpuTimesSnapshot = { idle: 150, total: 300 };
    expect(computeCpuPercent(prev, halfBusy)).toBe(50);

    const allBusy: CpuTimesSnapshot = { idle: 100, total: 400 };
    expect(computeCpuPercent(prev, allBusy)).toBe(100);

    const allIdle: CpuTimesSnapshot = { idle: 300, total: 400 };
    expect(computeCpuPercent(prev, allIdle)).toBe(0);

    expect(computeCpuPercent(prev, prev)).toBeNull();
    expect(
      computeCpuPercent(prev, { idle: 50, total: 250 }),
    ).toBeNull();
  });
});

describe("parseVmStatMemoryUsed", () => {
  test("matches Activity Monitor by excluding reclaimable file cache", () => {
    const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               18706.
Pages wired down:                        219159.
File-backed pages:                       775285.
Anonymous pages:                        1735800.
Pages occupied by compressor:            334793.
`;

    expect(parseVmStatMemoryUsed(vmStat)).toBe(37_515_296_768);
  });
});

describe("createSystemMetricsService", () => {
  test("first sample may have null CPU; later samples use deltas", () => {
    let tick = 0;
    let idle = 100;
    let total = 200;
    const service = track(
      createSystemMetricsService({
        autoStart: false,
        source: {
          nowIso: () =>
            new Date(Date.UTC(2026, 7, 20, 12, 0, tick)).toISOString(),
          hostname: () => "test-host",
          totalmem: () => 1000,
          memoryUsed: () => 600,
          cpuTimes: () => ({ idle, total }),
        },
      }),
    );

    const first = service.getMetrics();
    expect(first.hostName).toBe("test-host");
    expect(first.memoryTotalBytes).toBe(1000);
    expect(first.points).toHaveLength(1);
    expect(first.points[0]).toEqual({
      sampledAt: "2026-08-20T12:00:00.000Z",
      cpuPercent: null,
      memoryUsedBytes: 600,
    });
    expect(parseHostMetrics(first)).toEqual(first);

    tick = 5;
    idle = 150;
    total = 300;
    const second = service.sample();
    expect(second.points).toHaveLength(2);
    expect(second.points[1]?.cpuPercent).toBe(50);
    expect(second.points[1]?.memoryUsedBytes).toBe(600);
    expect(second.sampledAt).toBe("2026-08-20T12:00:05.000Z");
  });

  test("keeps a ring of at most maxPoints and notifies subscribers", () => {
    let tick = 0;
    let idle = 0;
    let total = 0;
    const service = track(
      createSystemMetricsService({
        autoStart: false,
        maxPoints: 3,
        source: {
          nowIso: () =>
            new Date(Date.UTC(2026, 7, 20, 12, 0, tick)).toISOString(),
          hostname: () => "ring-host",
          totalmem: () => 100,
          memoryUsed: () => 50,
          cpuTimes: () => {
            const snap = { idle, total };
            idle += 25;
            total += 100;
            return snap;
          },
        },
      }),
    );

    const seen: number[] = [];
    const unsub = service.subscribe((m) => seen.push(m.points.length));

    for (let i = 1; i <= 4; i++) {
      tick = i;
      service.sample();
    }
    unsub();

    const metrics = service.getMetrics();
    expect(metrics.points).toHaveLength(3);
    expect(metrics.points.map((p) => p.sampledAt)).toEqual([
      "2026-08-20T12:00:02.000Z",
      "2026-08-20T12:00:03.000Z",
      "2026-08-20T12:00:04.000Z",
    ]);
    // constructor baseline + 4 manual samples
    expect(seen).toEqual([2, 3, 3, 3]);
    expect(parseHostMetrics(metrics)).toEqual(metrics);
  });

  test("clamps memory used to 0..total", () => {
    const service = track(
      createSystemMetricsService({
        autoStart: false,
        source: {
          nowIso: () => "2026-08-20T12:00:00.000Z",
          hostname: () => "clamp-host",
          totalmem: () => 100,
          memoryUsed: () => 250,
          cpuTimes: () => ({ idle: 1, total: 1 }),
        },
      }),
    );
    expect(service.getMetrics().points[0]?.memoryUsedBytes).toBe(100);
  });
});

describe("GET /api/system/metrics", () => {
  const snapshot = validMetrics();

  test("rejects unauthenticated and host bearer", async () => {
    const unauthorized = await handleApi(
      new Request("http://local/api/system/metrics"),
      config,
      "/api/system/metrics",
      undefined,
      undefined,
      { getHostMetrics: () => snapshot },
    );
    expect(unauthorized?.status).toBe(401);

    const hostBearer = await handleApi(
      new Request("http://local/api/system/metrics", {
        headers: { authorization: `Bearer ${config.hostToken}` },
      }),
      config,
      "/api/system/metrics",
      undefined,
      undefined,
      { getHostMetrics: () => snapshot },
    );
    expect(hostBearer?.status).toBe(401);
  });

  test("returns no-store HostMetrics for dashboard cookie", async () => {
    const cookie = await loginCookie();
    const res = await handleApi(
      new Request("http://local/api/system/metrics", {
        headers: { cookie },
      }),
      config,
      "/api/system/metrics",
      undefined,
      undefined,
      { getHostMetrics: () => snapshot },
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control") ?? "").toContain("no-store");
    const body = (await res!.json()) as { data: HostMetrics };
    expect(parseHostMetrics(body.data)).toEqual(snapshot);
  });
});

describe("GET /api/system/metrics/events", () => {
  async function readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<string> {
    const { value, done } = await reader.read();
    if (done || !value) return "";
    return new TextDecoder().decode(value);
  }

  test("rejects unauthenticated requests", async () => {
    const res = await handleApi(
      new Request("http://local/api/system/metrics/events"),
      config,
      "/api/system/metrics/events",
      undefined,
      undefined,
      {
        getHostMetrics: () => validMetrics(),
        subscribeHostMetrics: () => () => {},
      },
    );
    expect(res?.status).toBe(401);
  });

  test("streams initial metrics event and unsubscribes on abort", async () => {
    const snapshot = validMetrics();
    let subscribed = 0;
    let unsubscribed = 0;
    const listeners = new Set<(m: HostMetrics) => void>();

    const cookie = await loginCookie();
    const ac = new AbortController();
    const res = await handleApi(
      new Request("http://local/api/system/metrics/events", {
        method: "GET",
        headers: { cookie, accept: "text/event-stream" },
        signal: ac.signal,
      }),
      config,
      "/api/system/metrics/events",
      undefined,
      undefined,
      {
        getHostMetrics: () => snapshot,
        subscribeHostMetrics: (listener) => {
          subscribed += 1;
          listeners.add(listener);
          return () => {
            unsubscribed += 1;
            listeners.delete(listener);
          };
        },
      },
    );

    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type") ?? "").toContain(
      "text/event-stream",
    );
    expect(res?.headers.get("cache-control") ?? "").toContain("no-store");
    expect(subscribed).toBe(1);

    const reader = res!.body!.getReader();
    const initial = await readChunk(reader);
    expect(initial).toContain("event: metrics\n");
    const dataLine = initial
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as {
      data: HostMetrics;
    };
    expect(parseHostMetrics(payload.data)).toEqual(snapshot);

    // Push a follow-up sample through the subscription.
    const next = validMetrics({
      points: [
        ...snapshot.points,
        point("2026-08-20T12:00:10.000Z", 33, 3_000),
      ],
    });
    for (const listener of listeners) listener(next);
    const pushed = await readChunk(reader);
    expect(pushed).toContain("event: metrics\n");
    expect(pushed).toContain("2026-08-20T12:00:10.000Z");

    ac.abort();
    // cancel path is the same cleanup as abort for this stream
    await reader.cancel().catch(() => {});
    expect(unsubscribed).toBeGreaterThanOrEqual(1);
    expect(listeners.size).toBe(0);
  });
});
