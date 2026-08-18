import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_LOCATIONS_IMPORT_META_KEY,
  closeDashboardDb,
  importLegacyDashboardLocations,
  listDashboardLocations,
  listResumeSessionCandidates,
  openDashboardDb,
  type DashboardDatabase,
} from "../daemon/dashboard-db";
import {
  configureDashboardDb,
  getSessionDashboard,
  resetStoreForTests,
} from "../daemon/store";

const tempDirs: string[] = [];
const openHandles: DashboardDatabase[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop()!;
    try {
      closeDashboardDb(handle);
    } catch {
      // test cleanup
    }
  }
  resetStoreForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeLegacyLocations(dir: string): {
  path: string;
  originalBytes: string;
  groupPath: string;
  worktreePath: string;
} {
  const groupPath = join(dir, "project");
  const worktreePath = groupPath;
  const path = join(dir, "omp-sessions-share-locations.json");
  // Preserve exact source formatting, including trailing newline and spacing.
  const originalBytes = `${JSON.stringify(
    {
      version: 1,
      locations: [
        {
          group: {
            kind: "folder",
            name: "project",
            path: groupPath,
          },
          worktree: {
            name: "project",
            path: worktreePath,
          },
          lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
        },
        {
          // Invalid entry must be skipped without rewriting the file.
          group: { kind: "nope", name: "bad", path: "/bad" },
          worktree: { name: "bad", path: "/bad" },
          lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    },
    null,
    2,
  )}\n`;
  writeFileSync(path, originalBytes, { mode: 0o600 });
  return { path, originalBytes, groupPath, worktreePath };
}

describe("INT-02 legacy locations rollback", () => {
  test("version-1 import keeps source bytes and is idempotent across open/import", () => {
    const dir = makeTemp("omp-legacy-rollback-");
    const legacy = writeLegacyLocations(dir);
    const dbPath = join(dir, "omp-sessions-share.sqlite");

    const first = openDashboardDb(dbPath);
    openHandles.push(first);

    const firstImport = importLegacyDashboardLocations(first, legacy.path);
    expect(firstImport).toEqual({ ran: true, count: 1 });
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.originalBytes);

    const imported = listDashboardLocations(first);
    expect(imported).toEqual([
      {
        group: {
          kind: "folder",
          name: "project",
          path: legacy.groupPath,
        },
        worktree: {
          name: "project",
          path: legacy.worktreePath,
        },
        lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
      },
    ]);
    // Legacy locations never become resume rows.
    expect(listResumeSessionCandidates(first)).toEqual([]);

    const flag = first.db
      .query("SELECT value FROM meta WHERE key = ?")
      .get(LEGACY_LOCATIONS_IMPORT_META_KEY) as { value: string };
    expect(flag.value).toBe("1");

    // Same open: second import is a pure no-op and still leaves source untouched.
    expect(importLegacyDashboardLocations(first, legacy.path)).toEqual({
      ran: false,
      count: 0,
    });
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.originalBytes);
    expect(listDashboardLocations(first)).toHaveLength(1);

    closeDashboardDb(first);
    openHandles.pop();

    // Re-open existing SQLite: import stays skipped, locations survive, bytes unchanged.
    const second = openDashboardDb(dbPath);
    openHandles.push(second);
    expect(importLegacyDashboardLocations(second, legacy.path)).toEqual({
      ran: false,
      count: 0,
    });
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.originalBytes);
    expect(listDashboardLocations(second)).toEqual(imported);
    expect(listResumeSessionCandidates(second)).toEqual([]);

    // Mutate source after import — rollback-safe bootstrap must not re-read it.
    writeFileSync(legacy.path, "corrupt-after-import", { mode: 0o600 });
    expect(importLegacyDashboardLocations(second, legacy.path)).toEqual({
      ran: false,
      count: 0,
    });
    expect(listDashboardLocations(second)).toEqual(imported);
    expect(readFileSync(legacy.path, "utf8")).toBe("corrupt-after-import");
  });

  test("store bootstrap imports once and leaves legacy JSON bytes intact across reloads", () => {
    const dir = makeTemp("omp-legacy-store-rollback-");
    const legacy = writeLegacyLocations(dir);
    const dbPath = join(dir, "dash.sqlite");

    configureDashboardDb(dbPath, legacy.path);
    expect(getSessionDashboard().locations).toEqual([
      {
        group: {
          kind: "folder",
          name: "project",
          path: legacy.groupPath,
        },
        worktree: {
          name: "project",
          path: legacy.worktreePath,
        },
        lastSessionStartedAt: "2026-08-12T00:00:00.000Z",
      },
    ]);
    expect(getSessionDashboard().recentSessions).toEqual([]);
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.originalBytes);

    // Source may later be deleted/corrupted; reopen still uses SQLite only.
    writeFileSync(legacy.path, "{not-json", { mode: 0o600 });
    resetStoreForTests();
    configureDashboardDb(dbPath, legacy.path);
    expect(getSessionDashboard().locations).toHaveLength(1);
    expect(getSessionDashboard().locations[0]!.worktree.path).toBe(
      legacy.worktreePath,
    );
    expect(getSessionDashboard().recentSessions).toEqual([]);
    expect(readFileSync(legacy.path, "utf8")).toBe("{not-json");
  });
});
