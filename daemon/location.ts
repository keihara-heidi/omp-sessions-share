/** Derive session group/worktree metadata from cwd (Git or folder). */

import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { SessionGroup, SessionWorktree } from "../lib/contracts";

export type SessionLocation = {
  group: SessionGroup;
  worktree: SessionWorktree;
};

/** Worktree label for sessions at a Shared Context branch-group root. */
export const SHARED_CONTEXT_ROOT_WORKTREE_NAME = "Shared context";

const cache = new Map<string, SessionLocation>();

const BRANCH_TTL_MS = 5_000;
const branchCache = new Map<string, { branch: string | undefined; expiresAt: number }>();

/** Current branch for a checkout. Empty/detached → undefined. Cached briefly. */
export function readGitBranch(cwd: string, now = Date.now()): string | undefined {
  const cached = branchCache.get(cwd);
  if (cached && cached.expiresAt > now) return cached.branch;
  const result = Bun.spawnSync(
    ["git", "-C", cwd, "branch", "--show-current"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const branch =
    result.exitCode === 0
      ? new TextDecoder().decode(result.stdout).trim() || undefined
      : undefined;
  branchCache.set(cwd, { branch, expiresAt: now + BRANCH_TTL_MS });
  return branch;
}

/**
 * Physical path seam (matches Superconductor `cd … && pwd -P`).
 * `realpathSync.native` when possible; otherwise `path.resolve`.
 */
export function canonicalizePath(input: string): string {
  try {
    return realpathSync.native(input);
  } catch {
    return resolve(input);
  }
}

/** Default Superconductor workspaces root (`~/.superconductor/workspaces`). */
export function defaultSharedWorkspacesRoot(): string {
  const home = process.env.HOME?.trim() || homedir();
  return join(home, ".superconductor", "workspaces");
}

/**
 * Pure seam: detect `…/workspaces/<workspace-id>/<branch-group>[/<child>]`.
 * Branch-group root is non-Git Shared Context; children are repo worktrees
 * (often symlinks). Does not touch the filesystem — pass `workspacesRoot` in tests.
 */
export function sharedContextLocation(
  logicalCwd: string,
  workspacesRoot: string = defaultSharedWorkspacesRoot(),
): SessionLocation | null {
  const cwd = resolve(logicalCwd);
  const root = resolve(workspacesRoot);
  const rel = relative(root, cwd);
  if (!rel || rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    return null;
  }
  const parts = rel.split(sep).filter(Boolean);
  // <workspace-id>/<branch-group>[/<child>/…]
  if (parts.length < 2) return null;

  const workspaceId = parts[0]!;
  const branchGroup = parts[1]!;
  const branchRoot = join(root, workspaceId, branchGroup);

  if (parts.length === 2) {
    return {
      group: { kind: "folder", name: branchGroup, path: branchRoot },
      worktree: {
        name: SHARED_CONTEXT_ROOT_WORKTREE_NAME,
        path: branchRoot,
      },
    };
  }

  const child = parts[2]!;
  const childPath = join(branchRoot, child);
  return {
    group: { kind: "folder", name: branchGroup, path: branchRoot },
    worktree: { name: child, path: childPath },
  };
}

function finalizeSharedLocation(location: SessionLocation): SessionLocation {
  return {
    group: {
      kind: "folder",
      name: location.group.name,
      path: canonicalizePath(location.group.path),
    },
    worktree: {
      name: location.worktree.name,
      path: canonicalizePath(location.worktree.path),
    },
  };
}

/** Non-Git fallback: group + worktree both use the given (canonical) path. */
export function folderLocation(cwd: string): SessionLocation {
  const name = basename(cwd) || cwd;
  return {
    group: { kind: "folder", name, path: cwd },
    worktree: { name, path: cwd },
  };
}

/**
 * Pure seam: map `git rev-parse --show-toplevel --git-common-dir` lines.
 * Relative commonDir is resolved against cwd.
 * If common dir basename is `.git`, repository path = dirname(common dir);
 * otherwise repository path = worktree root (linked/bare edge cases).
 * Callers should pass already-canonical paths for stable identity.
 */
export function locationFromGit(
  cwd: string,
  toplevel: string,
  commonDir: string,
): SessionLocation {
  const worktreePath = toplevel;
  const absoluteCommon = isAbsolute(commonDir)
    ? commonDir
    : resolve(cwd, commonDir);
  const repositoryPath =
    basename(absoluteCommon) === ".git"
      ? dirname(absoluteCommon)
      : worktreePath;
  return {
    group: {
      kind: "repository",
      name: basename(repositoryPath) || repositoryPath,
      path: repositoryPath,
    },
    worktree: {
      name: basename(worktreePath) || worktreePath,
      path: worktreePath,
    },
  };
}

function readGitLocation(canonicalCwd: string): SessionLocation | null {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      canonicalCwd,
      "rev-parse",
      "--show-toplevel",
      "--git-common-dir",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (result.exitCode !== 0) return null;
  const text = new TextDecoder().decode(result.stdout).trim();
  if (!text) return null;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const [toplevel, commonDir] = lines;
  if (!toplevel || !commonDir) return null;
  const absCommon = isAbsolute(commonDir)
    ? commonDir
    : resolve(canonicalCwd, commonDir);
  return locationFromGit(
    canonicalCwd,
    canonicalizePath(toplevel),
    canonicalizePath(absCommon),
  );
}

/**
 * Cached by logical cwd and canonical path.
 * Shared Context layout first; then Git on the physical path; folder fallback.
 * group/worktree paths are canonical where possible; caller keeps original cwd.
 */
export function resolveSessionLocation(cwd: string): SessionLocation {
  const logicalHit = cache.get(cwd);
  if (logicalHit) return logicalHit;

  const shared = sharedContextLocation(cwd);
  if (shared) {
    const location = finalizeSharedLocation(shared);
    cache.set(cwd, location);
    return location;
  }

  const canonicalCwd = canonicalizePath(cwd);
  if (canonicalCwd !== cwd) {
    const canonicalHit = cache.get(canonicalCwd);
    if (canonicalHit) {
      cache.set(cwd, canonicalHit);
      return canonicalHit;
    }
  }

  const location =
    readGitLocation(canonicalCwd) ?? folderLocation(canonicalCwd);
  cache.set(cwd, location);
  cache.set(canonicalCwd, location);
  return location;
}

/**
 * Resolve one repository directly, or recursively find repositories below a
 * plain project folder. A folder with no repositories remains registerable.
 */
export async function discoverRegistrationPaths(input: string): Promise<string[]> {
  const root = canonicalizePath(input);
  if (!(await stat(root)).isDirectory()) throw new Error("Path is not a directory");
  if (resolveSessionLocation(root).group.kind === "repository") return [root];

  const repositories: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const child = join(directory, entry.name);
      try {
        await stat(join(child, ".git"));
        repositories.push(child);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        pending.push(child);
      }
    }
  }
  return repositories.length > 0 ? repositories.sort() : [root];
}

export function clearLocationCache(): void {
  cache.clear();
  branchCache.clear();
}
