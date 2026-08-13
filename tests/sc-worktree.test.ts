import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBlankWorktree,
  createGitWorktree,
  parseCreatedWorktree,
  resolveScTarget,
} from "../daemon/sc-worktree";

const list = {
  kind: "workspace_list",
  response: {
    workspaces: [
      {
        id: "ws-personal",
        sections: [
          {
            kind: "projects",
            projects: [
              {
                project_id: "proj-omp",
                name: "omp-sessions-share",
                blank_worktree_creation: "available",
                items: [
                  { path: "/Users/dev/superconductor/projects/omp-sessions-share" },
                  { path: "/Users/dev/superconductor/projects/omp-sessions-share-feat" },
                ],
              },
              {
                project_id: "proj-blocked",
                name: "blocked",
                blank_worktree_creation: "unavailable",
                items: [{ path: "/tmp/blocked" }],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("resolveScTarget", () => {
  test("matches advertised main repo path", () => {
    expect(
      resolveScTarget(list, ["/Users/dev/superconductor/projects/omp-sessions-share"]),
    ).toEqual({ workspaceId: "ws-personal", projectId: "proj-omp" });
  });

  test("matches sibling worktree path under same project", () => {
    expect(
      resolveScTarget(list, [
        "/Users/dev/superconductor/projects/omp-sessions-share",
        "/Users/dev/superconductor/projects/omp-sessions-share-feat",
      ]),
    ).toEqual({ workspaceId: "ws-personal", projectId: "proj-omp" });
  });

  test("returns unavailable project when it is the only match", () => {
    expect(resolveScTarget(list, ["/tmp/blocked"])).toEqual({
      workspaceId: "ws-personal",
      projectId: "proj-blocked",
    });
  });

  test("returns null when no item matches", () => {
    expect(resolveScTarget(list, ["/tmp/unknown"])).toBeNull();
    expect(resolveScTarget(list, [])).toBeNull();
  });
});

describe("parseCreatedWorktree", () => {
  test("reads json path and branch", () => {
    expect(
      parseCreatedWorktree(
        JSON.stringify({
          response: { path: "/tmp/wt", branch: "feat/x" },
        }),
      ),
    ).toEqual({ path: "/tmp/wt", branch: "feat/x" });
  });

  test("reads nested worktree.path", () => {
    expect(
      parseCreatedWorktree(JSON.stringify({ worktree: { path: "/tmp/nested" } })),
    ).toEqual({ path: "/tmp/nested", branch: "" });
  });

  test("reads tab-separated text", () => {
    expect(parseCreatedWorktree("/tmp/wt\tfeat/x\n")).toEqual({
      path: "/tmp/wt",
      branch: "feat/x",
    });
  });

  test("rejects empty or relative output", () => {
    expect(parseCreatedWorktree("")).toBeNull();
    expect(parseCreatedWorktree("relative\tbranch")).toBeNull();
  });
});

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args[0]} failed`);
  }
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-git-wt-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "test"]);
  writeFileSync(join(dir, "README"), "init\n");
  runGit(dir, ["add", "README"]);
  runGit(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("createGitWorktree", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const path of created.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("adds a sibling worktree and branch without sc", async () => {
    const repo = initRepo();
    created.push(repo);
    const result = await createGitWorktree([repo]);
    created.push(result.path);
    expect(result.path.startsWith(`${realpathSync(repo)}-`)).toBe(true);
    const branch = Bun.spawnSync(
      ["git", "-C", result.path, "branch", "--show-current"],
      { stdout: "pipe", stderr: "ignore" },
    );
    expect(new TextDecoder().decode(branch.stdout).trim()).toMatch(/^omp-share\/[0-9a-f]{8}$/);
    expect(Bun.file(join(result.path, "README")).size).toBeGreaterThan(0);
  });

  test("resolves git root from a nested advertised path", async () => {
    const repo = initRepo();
    created.push(repo);
    const nested = join(repo, "src");
    mkdirSync(nested);
    const result = await createGitWorktree(["/tmp/not-a-repo", nested]);
    created.push(result.path);
    expect(result.path.startsWith(`${realpathSync(repo)}-`)).toBe(true);
  });

  test("rejects paths that are not a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-nogit-"));
    created.push(dir);
    await expect(createGitWorktree([dir])).rejects.toThrow("Not a git repository");
  });

  test("createBlankWorktree falls back to git when sc has no project", async () => {
    const repo = initRepo();
    created.push(repo);
    const result = await createBlankWorktree([repo]);
    created.push(result.path);
    expect(result.path.startsWith(`${realpathSync(repo)}-`)).toBe(true);
  });
});
