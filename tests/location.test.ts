import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizePath,
  clearLocationCache,
  folderLocation,
  locationFromGit,
  resolveSessionLocation,
  readGitBranch,
} from "../daemon/location";
import {
  getSession,
  resetStoreForTests,
  setNowForTests,
  upsertSession,
} from "../daemon/store";

afterEach(() => {
  clearLocationCache();
  resetStoreForTests();
});

describe("canonicalizePath", () => {
  test("resolves existing paths to physical realpath", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-canon-"));
    try {
      const physical = join(root, "real-dir");
      const logical = join(root, "link-dir");
      mkdirSync(physical);
      symlinkSync(physical, logical);
      expect(canonicalizePath(logical)).toBe(realpathSync(physical));
      expect(canonicalizePath(physical)).toBe(realpathSync(physical));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("folderLocation", () => {
  test("mirrors cwd as folder group and worktree", () => {
    expect(folderLocation("/tmp/scratch")).toEqual({
      group: { kind: "folder", name: "scratch", path: "/tmp/scratch" },
      worktree: { name: "scratch", path: "/tmp/scratch" },
    });
  });
});

describe("locationFromGit", () => {
  test("regular worktree: common dir basename .git → repo is dirname(common)", () => {
    expect(
      locationFromGit(
        "/Users/dev/omp/app",
        "/Users/dev/omp",
        "/Users/dev/omp/.git",
      ),
    ).toEqual({
      group: {
        kind: "repository",
        name: "omp",
        path: "/Users/dev/omp",
      },
      worktree: { name: "omp", path: "/Users/dev/omp" },
    });
  });

  test("linked worktree: common dir is main .git, toplevel is worktree root", () => {
    expect(
      locationFromGit(
        "/Users/dev/worktrees/feature-x/app",
        "/Users/dev/worktrees/feature-x",
        "/Users/dev/omp/.git",
      ),
    ).toEqual({
      group: {
        kind: "repository",
        name: "omp",
        path: "/Users/dev/omp",
      },
      worktree: {
        name: "feature-x",
        path: "/Users/dev/worktrees/feature-x",
      },
    });
  });

  test("relative commonDir .git resolves against cwd", () => {
    // Pure helper resolves relative commonDir against the cwd argument.
    expect(locationFromGit("/repo/sub", "/repo", ".git")).toEqual({
      group: { kind: "repository", name: "sub", path: "/repo/sub" },
      worktree: { name: "repo", path: "/repo" },
    });
    // Typical main-worktree shape uses toplevel as cwd for relative .git
    expect(locationFromGit("/repo", "/repo", ".git")).toEqual({
      group: { kind: "repository", name: "repo", path: "/repo" },
      worktree: { name: "repo", path: "/repo" },
    });
  });
  test("when common dir basename is not .git, repository path is worktree root", () => {
    expect(
      locationFromGit("/wt/project", "/wt/project", "/mirror/project.git"),
    ).toEqual({
      group: {
        kind: "repository",
        name: "project",
        path: "/wt/project",
      },
      worktree: { name: "project", path: "/wt/project" },
    });
  });
});


describe("resolveSessionLocation symlink canonicalization", () => {
  test("logical symlink cwd and physical target share group/worktree paths", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-loc-"));
    try {
      const physical = join(root, "physical-project");
      const logical = join(root, "logical-link");
      mkdirSync(physical);
      symlinkSync(physical, logical);

      const physicalReal = realpathSync(physical);
      expect(realpathSync(logical)).toBe(physicalReal);

      clearLocationCache();
      const viaLogical = resolveSessionLocation(logical);
      clearLocationCache();
      const viaPhysical = resolveSessionLocation(physicalReal);

      expect(viaLogical.group.path).toBe(viaPhysical.group.path);
      expect(viaLogical.worktree.path).toBe(viaPhysical.worktree.path);
      expect(viaLogical.group.path).toBe(physicalReal);
      expect(viaLogical.worktree.path).toBe(physicalReal);
      expect(viaLogical.group.kind).toBe("folder");
      expect(viaLogical.group.name).toBe(viaPhysical.group.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("upsertSession preserves logical cwd while canonicalizing group/worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-store-loc-"));
    try {
      const physical = join(root, "physical-project");
      const logical = join(root, "logical-link");
      mkdirSync(physical);
      symlinkSync(physical, logical);
      const physicalReal = realpathSync(physical);

      resetStoreForTests();
      setNowForTests(() => 1_700_000_000_000);

      const logicalSession = upsertSession({
        id: "sess-logical",
        title: "via symlink",
        cwd: logical,
        startedAt: "2026-08-12T00:00:00.000Z",
      });
      const physicalSession = upsertSession({
        id: "sess-physical",
        title: "via realpath",
        cwd: physicalReal,
        startedAt: "2026-08-12T00:00:00.000Z",
      });

      expect(logicalSession.id).toBe("sess-logical");
      expect(physicalSession.id).toBe("sess-physical");
      expect(logicalSession.cwd).toBe(logical);
      expect(physicalSession.cwd).toBe(physicalReal);
      expect(logicalSession.group.path).toBe(physicalSession.group.path);
      expect(logicalSession.worktree.path).toBe(physicalSession.worktree.path);
      expect(logicalSession.group.path).toBe(physicalReal);
      expect(getSession("sess-logical")?.cwd).toBe(logical);
      expect(getSession("sess-logical")?.id).toBe("sess-logical");
    } finally {
      rmSync(root, { recursive: true, force: true });
      resetStoreForTests();
    }
  });
});

describe("readGitBranch", () => {
  test("returns current branch and ignores non-git paths", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-branch-"));
    try {
      const git = Bun.spawnSync(["git", "init", "-b", "feat/show-branch"], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(git.exitCode).toBe(0);
      expect(readGitBranch(root)).toBe("feat/show-branch");
      expect(readGitBranch("/tmp/definitely-not-a-git-repo-omp")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      clearLocationCache();
    }
  });
});
