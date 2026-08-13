import { describe, expect, test } from "bun:test";
import {
  groupSessions,
  type SessionGroup as HierarchyGroup,
} from "../app/components/group-sessions";
import type { SessionSummary } from "../lib/contracts";

function session(
  partial: Pick<
    SessionSummary,
    "id" | "title" | "cwd" | "lastSeenAt" | "group" | "worktree"
  > &
    Partial<Pick<SessionSummary, "startedAt">>,
): SessionSummary {
  return {
    startedAt: partial.startedAt ?? "2026-08-12T00:00:00.000Z",
    ...partial,
  };
}

function ids(groups: HierarchyGroup[]): string[] {
  return groups.flatMap((g) =>
    g.worktrees.flatMap((w) => w.sessions.map((s) => s.id)),
  );
}

describe("groupSessions", () => {
  const repoA = {
    kind: "repository" as const,
    name: "omp",
    path: "/Users/dev/omp",
  };
  const mainWt = { name: "omp", path: "/Users/dev/omp" };
  const featureWt = {
    name: "feature-x",
    path: "/Users/dev/worktrees/feature-x",
  };
  const folderB = {
    kind: "folder" as const,
    name: "scratch",
    path: "/tmp/scratch",
  };
  const scratchWt = { name: "scratch", path: "/tmp/scratch" };

  const sMainOld = session({
    id: "s-main-old",
    title: "Refactor store",
    cwd: "/Users/dev/omp/daemon",
    lastSeenAt: "2026-08-12T01:00:00.000Z",
    group: repoA,
    worktree: mainWt,
  });
  const sMainNew = session({
    id: "s-main-new",
    title: "UI polish",
    cwd: "/Users/dev/omp/app",
    lastSeenAt: "2026-08-12T03:00:00.000Z",
    group: repoA,
    worktree: mainWt,
  });
  const sFeatureOld = session({
    id: "s-feature-old",
    title: "Older feature task",
    cwd: "/Users/dev/worktrees/feature-x/lib",
    lastSeenAt: "2026-08-12T01:30:00.000Z",
    group: repoA,
    worktree: featureWt,
  });
  const sFeature = session({
    id: "s-feature",
    title: "Grouping work",
    cwd: "/Users/dev/worktrees/feature-x/app",
    lastSeenAt: "2026-08-12T02:00:00.000Z",
    group: repoA,
    worktree: featureWt,
  });
  const sScratch = session({
    id: "s-scratch",
    title: "Notes",
    cwd: "/tmp/scratch",
    lastSeenAt: "2026-08-12T04:00:00.000Z",
    group: folderB,
    worktree: scratchWt,
  });
  const sOtherFolder = session({
    id: "s-other",
    title: "Unrelated",
    cwd: "/var/empty",
    lastSeenAt: "2026-08-12T00:30:00.000Z",
    group: { kind: "folder", name: "empty", path: "/var/empty" },
    worktree: { name: "empty", path: "/var/empty" },
  });

  const all = [
    sMainOld,
    sMainNew,
    sFeatureOld,
    sFeature,
    sScratch,
    sOtherFolder,
  ];

  test("empty query keeps all sessions in hierarchy", () => {
    const groups = groupSessions(all, "");
    expect(ids(groups).sort()).toEqual(all.map((s) => s.id).sort());
    expect(groups).toHaveLength(3);
    expect(ids(groupSessions(all, "  \t")).sort()).toEqual(
      all.map((s) => s.id).sort(),
    );
  });

  test("builds repository → worktree → session hierarchy", () => {
    const groups = groupSessions(
      [sMainOld, sMainNew, sFeature, sScratch],
      "   ",
    );
    const omp = groups.find((g) => g.path === repoA.path);
    expect(omp).toMatchObject({
      kind: "repository",
      name: "omp",
      path: repoA.path,
    });
    expect(omp!.worktrees.map((w) => w.path).sort()).toEqual(
      [mainWt.path, featureWt.path].sort(),
    );
    const main = omp!.worktrees.find((w) => w.path === mainWt.path)!;
    expect(main.sessions.map((s) => s.id).sort()).toEqual(
      ["s-main-old", "s-main-new"].sort(),
    );
    const scratch = groups.find((g) => g.path === folderB.path);
    expect(scratch).toMatchObject({ kind: "folder", name: "scratch" });
    expect(scratch!.worktrees).toHaveLength(1);
    expect(scratch!.worktrees[0]!.sessions.map((s) => s.id)).toEqual([
      "s-scratch",
    ]);
  });

  test("orders groups, worktrees, and sessions by newest descendant", () => {
    // newest overall: sScratch (04:00) → folder first
    // within omp: main (03:00 via sMainNew) before feature (02:00)
    // within main: sMainNew then sMainOld
    const groups = groupSessions(
      [sMainOld, sMainNew, sFeature, sScratch],
      "",
    );
    expect(groups.map((g) => g.path)).toEqual([folderB.path, repoA.path]);
    const omp = groups[1]!;
    expect(omp.worktrees.map((w) => w.path)).toEqual([
      mainWt.path,
      featureWt.path,
    ]);
    expect(omp.worktrees[0]!.sessions.map((s) => s.id)).toEqual([
      "s-main-new",
      "s-main-old",
    ]);
  });

  test("group name/path match includes entire group", () => {
    const byName = groupSessions(all, "OMP");
    expect(ids(byName).sort()).toEqual(
      ["s-main-old", "s-main-new", "s-feature-old", "s-feature"].sort(),
    );
    expect(byName).toHaveLength(1);
    expect(byName[0]!.worktrees).toHaveLength(2);

    const byPath = groupSessions(all, "/Users/dev/omp");
    expect(ids(byPath).sort()).toEqual(
      ["s-main-old", "s-main-new", "s-feature-old", "s-feature"].sort(),
    );
  });

  test("worktree name/path match includes entire worktree only", () => {
    // Two sessions in feature worktree; query matches worktree name only.
    // Neither session title is "feature-x", so inclusion is via worktree inheritance.
    const byName = groupSessions(all, "feature-x");
    expect(ids(byName).sort()).toEqual(["s-feature", "s-feature-old"].sort());
    expect(byName).toHaveLength(1);
    expect(byName[0]!.worktrees).toHaveLength(1);
    expect(byName[0]!.worktrees[0]!.path).toBe(featureWt.path);
    // main worktree sessions excluded
    expect(ids(byName)).not.toContain("s-main-new");
    expect(ids(byName)).not.toContain("s-main-old");

    const byWtPath = groupSessions(all, "/Users/dev/worktrees/feature-x");
    expect(ids(byWtPath).sort()).toEqual(["s-feature", "s-feature-old"].sort());
  });

  test("session title/cwd match keeps only matching sessions", () => {
    const byTitle = groupSessions(all, "polish");
    expect(ids(byTitle)).toEqual(["s-main-new"]);
    expect(byTitle[0]!.worktrees[0]!.sessions).toHaveLength(1);

    const byCwd = groupSessions(all, "worktrees/feature-x/app");
    expect(ids(byCwd)).toEqual(["s-feature"]);
  });

  test("search is case-insensitive and trims query", () => {
    expect(ids(groupSessions(all, "  notes  "))).toEqual(["s-scratch"]);
    expect(ids(groupSessions(all, "SCRATCH"))).toEqual(["s-scratch"]);
  });


  test("fuzzy terms can match across hierarchy and session fields", () => {
    expect(ids(groupSessions(all, "om gruping"))).toEqual(["s-feature"]);
    expect(ids(groupSessions(all, "featuer")).sort()).toEqual(
      ["s-feature", "s-feature-old"].sort(),
    );
    expect(ids(groupSessions(all, "ui app"))).toEqual(["s-main-new"]);
  });
  test("empty result when nothing matches", () => {
    expect(groupSessions(all, "zzz-no-match")).toEqual([]);
    expect(groupSessions([], "")).toEqual([]);
    expect(groupSessions([], "x")).toEqual([]);
  });

  test("preserves session ids for mobile open targets", () => {
    const groups = groupSessions(all, "");
    const allIds = ids(groups);
    expect(new Set(allIds).size).toBe(all.length);
    for (const s of all) {
      expect(allIds).toContain(s.id);
    }
    // filtered path also keeps original ids
    const filtered = groupSessions(all, "polish");
    expect(ids(filtered)).toEqual(["s-main-new"]);
  });
});
