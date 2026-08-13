import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHARED_CONTEXT_ROOT_WORKTREE_NAME,
  canonicalizePath,
  clearLocationCache,
  folderLocation,
  locationFromGit,
  resolveSessionLocation,
  sharedContextLocation,
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

describe("sharedContextLocation", () => {
  const root = "/Users/dev/.superconductor/workspaces";
  const uuid = "11111111-2222-3333-4444-555555555555";
  const featureRoot = `${root}/${uuid}/feature-x`;
  const mainRoot = `${root}/${uuid}/main`;

  test("feature-x/repo-a → folder group feature-x, worktree repo-a", () => {
    expect(
      sharedContextLocation(`${featureRoot}/repo-a`, root),
    ).toEqual({
      group: { kind: "folder", name: "feature-x", path: featureRoot },
      worktree: { name: "repo-a", path: `${featureRoot}/repo-a` },
    });
  });

  test("nested path under child still groups by branch + first child worktree", () => {
    expect(
      sharedContextLocation(`${featureRoot}/repo-a/src/app`, root),
    ).toEqual({
      group: { kind: "folder", name: "feature-x", path: featureRoot },
      worktree: { name: "repo-a", path: `${featureRoot}/repo-a` },
    });
  });

  test("group-root session gets Shared context worktree", () => {
    expect(sharedContextLocation(featureRoot, root)).toEqual({
      group: { kind: "folder", name: "feature-x", path: featureRoot },
      worktree: {
        name: SHARED_CONTEXT_ROOT_WORKTREE_NAME,
        path: featureRoot,
      },
    });
    expect(SHARED_CONTEXT_ROOT_WORKTREE_NAME).toBe("Shared context");
  });

  test("main/repo-a stays under main group (logical paths in pure seam)", () => {
    expect(sharedContextLocation(`${mainRoot}/repo-a`, root)).toEqual({
      group: { kind: "folder", name: "main", path: mainRoot },
      worktree: { name: "repo-a", path: `${mainRoot}/repo-a` },
    });
  });

  test("workspace-id alone or outside root is not Shared Context", () => {
    expect(sharedContextLocation(`${root}/${uuid}`, root)).toBeNull();
    expect(sharedContextLocation("/tmp/other", root)).toBeNull();
    expect(
      sharedContextLocation("/Users/dev/Projects/heidi/repo-a", root),
    ).toBeNull();
  });
});

describe("resolveSessionLocation Shared Context + symlink", () => {
  test("main/repo-a symlink: group stays main, worktree path is canonical target", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omp-sc-"));
    try {
      const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const workspaces = join(tmp, ".superconductor", "workspaces");
      const mainRoot = join(workspaces, uuid, "main");
      const physical = join(tmp, "physical-repo-a");
      const logicalChild = join(mainRoot, "repo-a");
      mkdirSync(mainRoot, { recursive: true });
      mkdirSync(physical);
      symlinkSync(physical, logicalChild);

      const pure = sharedContextLocation(logicalChild, workspaces);
      expect(pure).toEqual({
        group: { kind: "folder", name: "main", path: mainRoot },
        worktree: { name: "repo-a", path: logicalChild },
      });

      const prevHome = process.env.HOME;
      process.env.HOME = tmp;
      clearLocationCache();
      try {
        const physicalReal = realpathSync(physical);
        const mainReal = realpathSync(mainRoot);

        // Logical SC path first — must not poison physical-key cache.
        const viaLogical = resolveSessionLocation(logicalChild);
        expect(viaLogical.group).toEqual({
          kind: "folder",
          name: "main",
          path: mainReal,
        });
        expect(viaLogical.worktree.name).toBe("repo-a");
        expect(viaLogical.worktree.path).toBe(physicalReal);

        // Physical target outside SC: generic Git/folder grouping, not main.
        // worktree.path still canonical-equal; group must differ.
        const viaPhysical = resolveSessionLocation(physicalReal);
        expect(viaPhysical.worktree.path).toBe(physicalReal);
        expect(viaPhysical.group.path).not.toBe(mainReal);
        expect(viaPhysical.group.name).not.toBe("main");
        expect(viaPhysical.group.kind === "repository" || viaPhysical.group.kind === "folder").toBe(
          true,
        );

        // Order independence: physical first must not hijack later SC logical resolve.
        clearLocationCache();
        const physicalFirst = resolveSessionLocation(physicalReal);
        const logicalSecond = resolveSessionLocation(logicalChild);
        expect(logicalSecond.group).toEqual({
          kind: "folder",
          name: "main",
          path: mainReal,
        });
        expect(logicalSecond.worktree.path).toBe(physicalReal);
        expect(physicalFirst.group.path).not.toBe(logicalSecond.group.path);
        expect(physicalFirst.worktree.path).toBe(logicalSecond.worktree.path);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        clearLocationCache();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("same physical repo under two SC branch groups keeps distinct folder groups", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omp-sc-multi-"));
    try {
      const uuid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      const workspaces = join(tmp, ".superconductor", "workspaces");
      const mainRoot = join(workspaces, uuid, "main");
      const featureRoot = join(workspaces, uuid, "feature-x");
      const physical = join(tmp, "shared-physical-repo");
      mkdirSync(mainRoot, { recursive: true });
      mkdirSync(featureRoot, { recursive: true });
      mkdirSync(physical);
      const mainChild = join(mainRoot, "repo-a");
      const featureChild = join(featureRoot, "repo-a");
      symlinkSync(physical, mainChild);
      symlinkSync(physical, featureChild);

      const prevHome = process.env.HOME;
      process.env.HOME = tmp;
      clearLocationCache();
      try {
        const physicalReal = realpathSync(physical);
        const fromMain = resolveSessionLocation(mainChild);
        const fromFeature = resolveSessionLocation(featureChild);

        expect(fromMain.group).toEqual({
          kind: "folder",
          name: "main",
          path: realpathSync(mainRoot),
        });
        expect(fromFeature.group).toEqual({
          kind: "folder",
          name: "feature-x",
          path: realpathSync(featureRoot),
        });
        // Canonical worktree targets match; SC groups stay distinct.
        expect(fromMain.worktree.path).toBe(physicalReal);
        expect(fromFeature.worktree.path).toBe(physicalReal);
        expect(fromMain.worktree.name).toBe("repo-a");
        expect(fromFeature.worktree.name).toBe("repo-a");
        expect(fromMain.group.path).not.toBe(fromFeature.group.path);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        clearLocationCache();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("feature-x group-root resolves Shared context worktree under HOME workspaces", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omp-sc-root-"));
    try {
      const uuid = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
      const workspaces = join(tmp, ".superconductor", "workspaces");
      const featureRoot = join(workspaces, uuid, "feature-x");
      mkdirSync(featureRoot, { recursive: true });

      const prevHome = process.env.HOME;
      process.env.HOME = tmp;
      clearLocationCache();
      try {
        const resolved = resolveSessionLocation(featureRoot);
        expect(resolved).toEqual({
          group: {
            kind: "folder",
            name: "feature-x",
            path: realpathSync(featureRoot),
          },
          worktree: {
            name: "Shared context",
            path: realpathSync(featureRoot),
          },
        });
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        clearLocationCache();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
