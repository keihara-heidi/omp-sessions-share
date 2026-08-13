/** Create and remove linked worktrees using the local Git CLI. */

import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

function outputText(value: Uint8Array): string {
  return new TextDecoder().decode(value).trim();
}

function gitToplevel(cwd: string): string | null {
  const result = Bun.spawnSync(
    ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (result.exitCode !== 0) return null;
  return outputText(result.stdout) || null;
}

function findGitRepo(advertisedPaths: string[]): string | null {
  for (const path of advertisedPaths) {
    if (!path) continue;
    const top = gitToplevel(path);
    if (top) return top;
  }
  return null;
}

export type GitWorktree = {
  path: string;
  branch?: string;
};

/** List every checkout registered in the repository containing `path`. */
export function listGitWorktrees(path: string): GitWorktree[] {
  const result = Bun.spawnSync(
    ["git", "-C", path, "worktree", "list", "--porcelain", "-z"],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (result.exitCode !== 0) return [];

  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  const flush = () => {
    if (current) worktrees.push(current);
  };
  for (const field of new TextDecoder().decode(result.stdout).split("\0")) {
    if (field.startsWith("worktree ")) {
      flush();
      current = { path: field.slice("worktree ".length) };
      continue;
    }
    if (current && field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    }
  }
  flush();
  return worktrees.filter((worktree) => worktree.path.length > 0);
}

/** Add a sibling linked worktree with a fresh local branch. */
export async function createGitWorktree(advertisedPaths: string[]): Promise<{
  path: string;
}> {
  const repo = findGitRepo(advertisedPaths);
  if (!repo) throw new Error("Not a git repository");

  let lastError = "git worktree add failed";
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomBytes(4).toString("hex");
    const dest = join(dirname(repo), `${basename(repo)}-${id}`);
    const result = Bun.spawnSync(
      ["git", "-C", repo, "worktree", "add", "-b", `omp-share/${id}`, dest],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode === 0) return { path: dest };
    lastError = outputText(result.stderr) || lastError;
  }
  throw new Error(lastError);
}

/** Remove a registered linked worktree without forcing away local changes. */
export async function removeGitWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<void> {
  const repo = gitToplevel(repositoryPath);
  const worktree = gitToplevel(worktreePath);
  if (!repo || !worktree) throw new Error("Not a git repository");
  if (repo === worktree) throw new Error("Cannot delete the primary worktree");

  const listed = Bun.spawnSync(
    ["git", "-C", repo, "worktree", "list", "--porcelain"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) throw new Error("Could not inspect worktrees");
  const registeredPaths = outputText(listed.stdout)
    .split("\n")
    .flatMap((line) => (line.startsWith("worktree ") ? [line.slice(9)] : []));
  if (!registeredPaths.includes(worktree)) throw new Error("Worktree not found");

  const result = Bun.spawnSync(
    ["git", "-C", repo, "worktree", "remove", worktree],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode === 0) return;

  const detail = outputText(result.stderr).toLowerCase();
  if (detail.includes("modified or untracked files")) {
    throw new Error("Worktree has uncommitted changes");
  }
  throw new Error("Could not delete worktree");
}
