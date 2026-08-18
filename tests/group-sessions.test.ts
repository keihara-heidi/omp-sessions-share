import { describe, expect, test } from "bun:test";
import {
  groupSessions,
  projectSessions,
  projectWorkspaces,
  type SessionGroup as HierarchyGroup,
} from "../app/components/group-sessions";
import type {
  RecentSessionSummary,
  SessionSummary,
} from "../lib/contracts";

function session(
  partial: Pick<
    SessionSummary,
    "id" | "title" | "cwd" | "lastSeenAt" | "group" | "worktree"
  > &
    Partial<Pick<SessionSummary, "startedAt">>,
): SessionSummary {
  return {
    startedAt: partial.startedAt ?? partial.lastSeenAt,
    ...partial,
  };
}

function ids(groups: HierarchyGroup[]): string[] {
  return groups.flatMap((g) =>
    g.worktrees.flatMap((w) => w.sessions.map((s) => s.id)),
  );
}

function recentIds(groups: HierarchyGroup[]): string[] {
  return groups.flatMap((g) =>
    g.worktrees.flatMap((w) => w.recentSessions.map((r) => r.id)),
  );
}

describe("groupSessions", () => {
  const repoA = {
    kind: "repository" as const,
    name: "omp",
    path: "/Users/dev/omp",
  };
  const mainWt = { name: "omp", path: "/Users/dev/omp", branch: "main" };
  const featureWt = {
    name: "feature-x",
    path: "/Users/dev/worktrees/feature-x",
    branch: "feat/grouping",
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

  test("orders groups, worktrees, and sessions by newest started descendant", () => {
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

  test("lastSeenAt heartbeats do not reorder groups or worktrees", () => {
    const before = groupSessions(
      [sMainOld, sMainNew, sFeature, sScratch],
      "",
    );
    const after = groupSessions(
      [
        { ...sMainOld, lastSeenAt: "2026-08-12T09:00:00.000Z" },
        sMainNew,
        { ...sFeature, lastSeenAt: "2026-08-12T08:00:00.000Z" },
        sScratch,
      ],
      "",
    );
    expect(after.map((g) => g.path)).toEqual(before.map((g) => g.path));
    expect(after[1]!.worktrees.map((w) => w.path)).toEqual(
      before[1]!.worktrees.map((w) => w.path),
    );
    expect(after[1]!.worktrees[0]!.sessions.map((s) => s.id)).toEqual(
      before[1]!.worktrees[0]!.sessions.map((s) => s.id),
    );
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

  test("git branch match includes entire worktree", () => {
    const byBranch = groupSessions(all, "feat/grouping");
    expect(ids(byBranch).sort()).toEqual(["s-feature", "s-feature-old"].sort());
    expect(byBranch[0]!.worktrees[0]!.branch).toBe("feat/grouping");
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
    expect(ids(groupSessions(all, "om gruping")).sort()).toEqual(
      ["s-feature", "s-feature-old"].sort(),
    );
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

  test("keeps and searches worktrees with no live sessions", () => {
    const locations = [
      {
        group: repoA,
        worktree: featureWt,
        lastSessionStartedAt: "2026-08-12T02:00:00.000Z",
      },
    ];
    const groups = groupSessions([], "", locations);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.worktrees).toHaveLength(1);
    expect(groups[0]!.worktrees[0]).toMatchObject({
      path: featureWt.path,
      sessions: [],
    });
    expect(groupSessions([], "feature-x", locations)).toHaveLength(1);
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

describe("groupSessions recent sessions", () => {
  const repoA = {
    kind: "repository" as const,
    name: "omp",
    path: "/Users/dev/omp",
  };
  const mainWt = { name: "omp", path: "/Users/dev/omp", branch: "main" };
  const featureWt = {
    name: "feature-x",
    path: "/Users/dev/worktrees/feature-x",
    branch: "feat/grouping",
  };
  const archiveWt = { name: "archive", path: "/Users/dev/worktrees/archive" };

  const sMain = session({
    id: "s-main",
    title: "UI polish",
    cwd: "/Users/dev/omp/app",
    lastSeenAt: "2026-08-12T03:00:00.000Z",
    group: repoA,
    worktree: mainWt,
  });

  function recent(
    partial: Pick<RecentSessionSummary, "id" | "title" | "lastSeenAt"> &
      Partial<Pick<RecentSessionSummary, "group" | "worktree">>,
  ): RecentSessionSummary {
    return { group: repoA, worktree: mainWt, ...partial };
  }

  const rMainOld = recent({
    id: "r-main-old",
    title: "Fix daemon crash",
    lastSeenAt: "2026-08-10T01:00:00.000Z",
  });
  const rMainNew = recent({
    id: "r-main-new",
    title: "Write migration",
    lastSeenAt: "2026-08-11T05:00:00.000Z",
  });
  const rArchive = recent({
    id: "r-archive",
    title: "Spelunk old logs",
    lastSeenAt: "2026-08-09T12:00:00.000Z",
    worktree: archiveWt,
  });

  test("attaches recents under their original group and worktree", () => {
    const groups = groupSessions([sMain], "", [], [rMainOld, rMainNew]);
    expect(groups).toHaveLength(1);
    const main = groups[0]!.worktrees.find((w) => w.path === mainWt.path)!;
    expect(main.sessions.map((s) => s.id)).toEqual(["s-main"]);
    expect(main.recentSessions.map((r) => r.id).sort()).toEqual(
      ["r-main-new", "r-main-old"].sort(),
    );
    // no global section: every recent lives inside a group's worktree
    expect(recentIds(groups).sort()).toEqual(
      ["r-main-new", "r-main-old"].sort(),
    );
  });

  test("includes recent-only worktrees without live sessions or locations", () => {
    const groups = groupSessions([sMain], "", [], [rArchive]);
    const omp = groups.find((g) => g.path === repoA.path)!;
    const archive = omp.worktrees.find((w) => w.path === archiveWt.path)!;
    expect(archive.sessions).toEqual([]);
    expect(archive.recentSessions.map((r) => r.id)).toEqual(["r-archive"]);
  });

  test("recent-only input still produces hierarchy", () => {
    const groups = groupSessions([], "", [], [rArchive]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.path).toBe(repoA.path);
    expect(recentIds(groups)).toEqual(["r-archive"]);
  });

  test("sorts recents by lastSeenAt descending within a worktree", () => {
    const groups = groupSessions([], "", [], [rMainOld, rMainNew]);
    const main = groups[0]!.worktrees.find((w) => w.path === mainWt.path)!;
    expect(main.recentSessions.map((r) => r.id)).toEqual([
      "r-main-new",
      "r-main-old",
    ]);
  });

  test("search matches recent titles and keeps only matching recents", () => {
    const groups = groupSessions(
      [sMain],
      "migration",
      [],
      [rMainOld, rMainNew],
    );
    expect(recentIds(groups)).toEqual(["r-main-new"]);
    expect(ids(groups)).toEqual([]);
  });

  test("group and worktree matches include recents via inheritance", () => {
    const byGroup = groupSessions([sMain], "omp", [], [rMainNew, rArchive]);
    expect(recentIds(byGroup).sort()).toEqual(
      ["r-archive", "r-main-new"].sort(),
    );
    const byWorktree = groupSessions([sMain], "archive", [], [
      rMainNew,
      rArchive,
    ]);
    expect(recentIds(byWorktree)).toEqual(["r-archive"]);
    expect(ids(byWorktree)).toEqual([]);
  });

  test("drops recents whose id is already live", () => {
    const ghost = recent({
      id: "s-main",
      title: "UI polish",
      lastSeenAt: "2026-08-12T02:00:00.000Z",
    });
    const groups = groupSessions([sMain], "", [], [ghost, rMainOld]);
    expect(recentIds(groups)).toEqual(["r-main-old"]);
    expect(ids(groups)).toEqual(["s-main"]);
  });

  test("live ordering semantics unaffected by recent heartbeats", () => {
    // Recents in a live worktree never bump its ordering timestamp.
    const featureSession = session({
      id: "s-feature",
      title: "Grouping work",
      cwd: featureWt.path,
      lastSeenAt: "2026-08-12T02:00:00.000Z",
      group: repoA,
      worktree: featureWt,
    });
    const noisy = recent({
      id: "r-noisy",
      title: "Very recent recent",
      lastSeenAt: "2026-08-12T09:00:00.000Z",
      worktree: featureWt,
    });
    const before = groupSessions([sMain, featureSession], "", []);
    const after = groupSessions([sMain, featureSession], "", [], [noisy]);
    expect(after[0]!.worktrees.map((w) => w.path)).toEqual(
      before[0]!.worktrees.map((w) => w.path),
    );
  });

  test("worktrees keep empty recentSessions when none provided", () => {
    const groups = groupSessions([sMain], "");
    expect(groups[0]!.worktrees[0]!.recentSessions).toEqual([]);
  });
});

describe("dashboard page projections", () => {
  const group = {
    kind: "repository" as const,
    name: "dashboard",
    path: "/Users/dev/dashboard",
  };
  const worktree = {
    name: "feature",
    path: "/Users/dev/worktrees/feature",
    branch: "feat/navigation",
  };
  const live = session({
    id: "live-projection",
    title: "Unique conversation title",
    cwd: `${worktree.path}/app`,
    lastSeenAt: "2026-08-12T04:00:00.000Z",
    group,
    worktree,
  });
  const recent: RecentSessionSummary = {
    id: "recent-projection",
    title: "Remember this conversation",
    lastSeenAt: "2026-08-12T03:00:00.000Z",
    group,
    worktree,
  };
  const dashboard = {
    sessions: [live],
    locations: [],
    recentSessions: [recent],
  };

  test("Sessions projects matching live and recent rows", () => {
    expect(projectSessions(dashboard, "unique")).toEqual({
      live: [live],
      recent: [],
    });
    expect(projectSessions(dashboard, "remember")).toEqual({
      live: [],
      recent: [recent],
    });
  });

  test("Workspaces searches workspace fields but not hidden session titles", () => {
    expect(projectWorkspaces(dashboard, "feat/navigation")).toHaveLength(1);
    expect(projectWorkspaces(dashboard, "unique conversation")).toEqual([]);
  });
});
