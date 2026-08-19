import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEALTH_CHECK_IDS,
  overallHealthLevel,
  parseSystemHealth,
  parsePluginUpdateStatus,
  type HealthCheck,
  type HealthCheckId,
  type HealthLevel,
  type SystemHealth,
} from "../lib/contracts";
import { createSystemHealthService } from "../daemon/system-health";
import { createPluginUpdateService } from "../daemon/plugin-update";

const tempDirs: string[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function healthCheck(
  id: HealthCheckId,
  level: HealthLevel = "healthy",
  checkedAt = "2026-08-18T12:00:00.000Z",
): HealthCheck {
  return {
    id,
    label: id,
    level,
    summary: `${id} summary`,
    checkedAt,
  };
}

function allProbeOverrides(
  level: HealthLevel = "healthy",
): Partial<Record<HealthCheckId, (checkedAt: string) => HealthCheck>> {
  return Object.fromEntries(
    HEALTH_CHECK_IDS.map((id) => [
      id,
      (checkedAt: string) => healthCheck(id, level, checkedAt),
    ]),
  );
}

function serviceWithProbes(
  probes: Partial<
    Record<
      HealthCheckId,
      (checkedAt: string) => HealthCheck | Promise<HealthCheck>
    >
  >,
  now: () => number = () => Date.parse("2026-08-18T12:00:00.000Z"),
) {
  return createSystemHealthService({
    isSleepInhibitorActive: () => false,
    isSleepInhibitorRequired: () => false,
    probes,
    now,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("system health contract", () => {
  test("enforces stable ids, unique checks, timestamps, and overall precedence", () => {
    const checks = HEALTH_CHECK_IDS.map((id) => healthCheck(id));
    const valid: SystemHealth = {
      overall: "healthy",
      checkedAt: "2026-08-18T12:00:00.000Z",
      checks,
    };
    expect(parseSystemHealth(valid)).toEqual(valid);
    expect(parseSystemHealth({ ...valid, overall: "warning" })).toBeNull();
    expect(
      parseSystemHealth({
        ...valid,
        checks: checks.map((c) => ({ ...c, id: "other" })),
      }),
    ).toBeNull();
    expect(
      parseSystemHealth({
        ...valid,
        checks: [...checks.slice(0, -1), checks[0]],
      }),
    ).toBeNull();
    expect(
      parseSystemHealth({
        ...valid,
        checks: checks.map((c, i) =>
          i === 0 ? { ...c, summary: "x".repeat(257) } : c,
        ),
      }),
    ).toBeNull();

    expect(overallHealthLevel(["healthy", "unknown"])).toBe("unknown");
    expect(overallHealthLevel(["healthy", "unknown", "warning"])).toBe(
      "warning",
    );
    expect(overallHealthLevel(["warning", "unavailable"])).toBe("unavailable");
  });
});

describe("system health collection", () => {
  test("returns all healthy checks in stable order", async () => {
    const result = await serviceWithProbes(allProbeOverrides()).getHealth();
    expect(result.overall).toBe("healthy");
    expect(result.checks.map((check) => check.id)).toEqual([
      ...HEALTH_CHECK_IDS,
    ]);
    expect(parseSystemHealth(result)).toEqual(result);
  });

  test("starts independent checks concurrently and soft-fails one rejection", async () => {
    const gate = Promise.withResolvers<void>();
    const started: HealthCheckId[] = [];
    const probes = Object.fromEntries(
      HEALTH_CHECK_IDS.map((id) => [
        id,
        async (checkedAt: string) => {
          started.push(id);
          if (id === "github-cli")
            throw new Error("secret stderr /private/path");
          await gate.promise;
          return healthCheck(id, "healthy", checkedAt);
        },
      ]),
    );
    const pending = serviceWithProbes(probes).getHealth();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([...HEALTH_CHECK_IDS]);
    gate.resolve();

    const result = await pending;
    expect(
      result.checks.find((check) => check.id === "github-cli"),
    ).toMatchObject({
      level: "unknown",
      summary: "Health check did not complete",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret stderr");
    expect(serialized).not.toContain("/private/path");
  });

  test("reuses cache and deduplicates simultaneous misses", async () => {
    let now = Date.parse("2026-08-18T12:00:00.000Z");
    let calls = 0;
    const probes = Object.fromEntries(
      HEALTH_CHECK_IDS.map((id) => [
        id,
        (checkedAt: string) => {
          calls += 1;
          return healthCheck(id, "healthy", checkedAt);
        },
      ]),
    );
    const service = serviceWithProbes(probes, () => now);
    const [first, simultaneous] = await Promise.all([
      service.getHealth(),
      service.getHealth(),
    ]);
    expect(calls).toBe(HEALTH_CHECK_IDS.length);
    expect(simultaneous).toEqual(first);

    const cached = await service.getHealth();
    expect(calls).toBe(HEALTH_CHECK_IDS.length);
    expect(cached.checkedAt).toBe(first.checkedAt);

    now += 20_001;
    const refreshed = await service.getHealth();
    expect(calls).toBe(HEALTH_CHECK_IDS.length * 2);
    expect(refreshed.checkedAt).not.toBe(first.checkedAt);
  });

  test("reports plugin and copied runtime versions without returning paths", async () => {
    const dir = makeTemp("omp-health-version-");
    const runtime = join(dir, "runtime.json");
    const installed = join(dir, "installed.json");
    writeFileSync(
      runtime,
      JSON.stringify({ name: "omp-sessions-share", version: "0.6.3" }),
    );
    writeFileSync(
      installed,
      JSON.stringify({ name: "omp-sessions-share", version: "0.7.0" }),
    );
    const probes = allProbeOverrides();
    delete probes["runtime-version"];
    const result = await createSystemHealthService({
      isSleepInhibitorActive: () => false,
      isSleepInhibitorRequired: () => false,
      runtimePackagePath: runtime,
      installedPackagePath: installed,
      probes,
      now: () => Date.parse("2026-08-18T12:00:00.000Z"),
    }).getHealth();
    const version = result.checks.find(
      (check) => check.id === "runtime-version",
    );
    expect(version).toMatchObject({
      level: "warning",
      summary: "Plugin 0.7.0, runtime 0.6.3",
    });
    expect(JSON.stringify(result)).not.toContain(dir);
  });

  test("bounds an unresponsive managed launcher and returns no command output", async () => {
    const bin = makeTemp("omp-health-bin-");
    const launcher = join(bin, "omp");
    writeFileSync(
      launcher,
      "#!/bin/sh\n# omp-sessions-share-owned-launcher\nprintf 'private stdout /private/path'\nexec sleep 10\n",
    );
    chmodSync(launcher, 0o700);
    const probes = allProbeOverrides();
    delete probes["dashboard-omp"];

    const startedAt = Date.now();
    const result = await createSystemHealthService({
      isSleepInhibitorActive: () => false,
      isSleepInhibitorRequired: () => false,
      dashboardOmpPath: launcher,
      probes,
    }).getHealth();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(
      result.checks.find((check) => check.id === "dashboard-omp"),
    ).toMatchObject({
      level: "warning",
      summary: "Dashboard OMP launcher did not report a version",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private stdout");
    expect(serialized).not.toContain("/private/path");
  }, 6_000);
});

describe("plugin updates", () => {
  test("checks the pinned main commit against the installed version", async () => {
    const dir = makeTemp("omp-update-");
    const installed = join(dir, "package.json");
    const commit = "a".repeat(40);
    writeFileSync(
      installed,
      JSON.stringify({ name: "omp-sessions-share", version: "0.9.1" }),
    );
    const service = createPluginUpdateService({
      installedPackagePath: installed,
      resolveCommit: async () => commit,
      fetchPackage: async () => ({
        name: "omp-sessions-share",
        version: "0.10.0",
      }),
    });

    const status = await service.check();
    expect(status).toEqual({
      currentVersion: "0.9.1",
      latestVersion: "0.10.0",
      commit,
      updateAvailable: true,
    });
    expect(parsePluginUpdateStatus(status)).toEqual(status);
    expect(
      parsePluginUpdateStatus({ ...status, updateAvailable: false }),
    ).toBeNull();
  });

  test("schedules one exact commit and rejects invalid or duplicate starts", () => {
    const scheduled: string[] = [];
    const service = createPluginUpdateService({
      schedule: (commit) => scheduled.push(commit),
    });
    const commit = "b".repeat(40);

    expect(() => service.start("main")).toThrow("Invalid update commit");
    service.start(commit);
    expect(scheduled).toEqual([commit]);
    expect(() => service.start(commit)).toThrow("Update already started");
  });
});
