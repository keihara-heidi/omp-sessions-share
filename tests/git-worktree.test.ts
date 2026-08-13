import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitWorktree,
  listGitWorktrees,
  removeGitWorktree,
} from "../daemon/git-worktree";

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || `git ${args[0]} failed`,
    );
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

describe("Git worktrees", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const path of created.splice(0).reverse()) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("adds a sibling worktree and branch", async () => {
    const repo = initRepo();
    created.push(repo);
    const result = await createGitWorktree([repo]);
    created.push(result.path);

    expect(result.path.startsWith(`${realpathSync(repo)}-`)).toBe(true);
    const branch = Bun.spawnSync(
      ["git", "-C", result.path, "branch", "--show-current"],
      { stdout: "pipe", stderr: "ignore" },
    );
    expect(new TextDecoder().decode(branch.stdout).trim()).toMatch(
      /^omp-share\/[0-9a-f]{8}$/,
    );
    expect(Bun.file(join(result.path, "README")).size).toBeGreaterThan(0);
  });

  test("lists primary and linked worktrees with branches", async () => {
    const repo = initRepo();
    created.push(repo);
    const linked = await createGitWorktree([repo]);
    created.push(linked.path);

    const listed = listGitWorktrees(linked.path);
    expect(listed.map((worktree) => worktree.path).sort()).toEqual(
      [realpathSync(repo), realpathSync(linked.path)].sort(),
    );
    expect(listed.find((worktree) => worktree.path === realpathSync(repo))?.branch).toBeTruthy();
    expect(
      listed.find((worktree) => worktree.path === realpathSync(linked.path))?.branch,
    ).toMatch(/^omp-share\/[0-9a-f]{8}$/);
  });

  test("resolves the repository from a nested advertised path", async () => {
    const repo = initRepo();
    created.push(repo);
    const nested = join(repo, "src");
    mkdirSync(nested);

    const result = await createGitWorktree(["/tmp/not-a-repo", nested]);
    created.push(result.path);
    expect(result.path.startsWith(`${realpathSync(repo)}-`)).toBe(true);
  });

  test("rejects paths that are not a Git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-nogit-"));
    created.push(dir);
    await expect(createGitWorktree([dir])).rejects.toThrow(
      "Not a git repository",
    );
  });

  test("removes a clean linked worktree but keeps its branch", async () => {
    const repo = initRepo();
    created.push(repo);
    const result = await createGitWorktree([repo]);
    const branch = new TextDecoder()
      .decode(
        Bun.spawnSync(
          ["git", "-C", result.path, "branch", "--show-current"],
          { stdout: "pipe", stderr: "ignore" },
        ).stdout,
      )
      .trim();

    await removeGitWorktree(repo, result.path);
    expect(await Bun.file(result.path).exists()).toBe(false);
    const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list", branch], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(branches.stdout)).toContain(branch);
  });

  test("refuses to remove the primary or a dirty worktree", async () => {
    const repo = initRepo();
    created.push(repo);
    await expect(removeGitWorktree(repo, repo)).rejects.toThrow(
      "Cannot delete the primary worktree",
    );

    const result = await createGitWorktree([repo]);
    created.push(result.path);
    writeFileSync(join(result.path, "untracked.txt"), "keep me\n");
    await expect(removeGitWorktree(repo, result.path)).rejects.toThrow(
      "Worktree has uncommitted changes",
    );
  });
});
