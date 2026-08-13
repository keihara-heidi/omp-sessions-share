/** Create a blank worktree: Superconductor when available, else git. */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";


export type ScTarget = { workspaceId: string; projectId: string };

type ListedProject = {
  id: string;
  name: string;
  blank: string | undefined;
  itemPaths: string[];
};

type ListedWorkspace = { id: string; projects: ListedProject[] };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function unwrap(v: unknown): unknown {
  const o = asRecord(v);
  if (!o) return v;
  if ("response" in o) return unwrap(o.response);
  if ("data" in o) return unwrap(o.data);
  return v;
}

function stringField(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 1024) {
      return value;
    }
  }
  return null;
}

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function matchesAdvertised(path: string, advertised: string[]): boolean {
  return advertised.some((candidate) => related(path, candidate));
}

export function parseWorkspaceList(v: unknown): ListedWorkspace[] {
  const root = asRecord(unwrap(v));
  const workspaces = root?.workspaces;
  if (!Array.isArray(workspaces)) return [];
  const out: ListedWorkspace[] = [];
  for (const ws of workspaces) {
    const w = asRecord(ws);
    const id = w ? stringField(w, "id") : null;
    if (!id) continue;
    const projects: ListedProject[] = [];
    const sections = Array.isArray(w?.sections) ? w.sections : [];
    for (const section of sections) {
      const listed = asRecord(section)?.projects;
      if (!Array.isArray(listed)) continue;
      for (const project of listed) {
        const p = asRecord(project);
        const projectId = p ? stringField(p, "project_id", "id") : null;
        if (!p || !projectId) continue;
        const items = Array.isArray(p.items) ? p.items : [];
        projects.push({
          id: projectId,
          name: stringField(p, "name") ?? "",
          blank:
            typeof p.blank_worktree_creation === "string"
              ? p.blank_worktree_creation
              : undefined,
          itemPaths: items.flatMap((item) => {
            const path = asRecord(item) ? stringField(asRecord(item)!, "path") : null;
            return path ? [path] : [];
          }),
        });
      }
    }
    out.push({ id, projects });
  }
  return out;
}

export function resolveScTarget(
  listJson: unknown,
  advertisedPaths: string[],
): ScTarget | null {
  const advertised = advertisedPaths.filter((path) => path.length > 0);
  if (advertised.length === 0) return null;
  const hits: Array<ScTarget & { available: boolean }> = [];
  for (const workspace of parseWorkspaceList(listJson)) {
    for (const project of workspace.projects) {
      if (!project.itemPaths.some((path) => matchesAdvertised(path, advertised))) {
        continue;
      }
      hits.push({
        workspaceId: workspace.id,
        projectId: project.id,
        available: project.blank !== "unavailable",
      });
    }
  }
  const hit = hits.find((candidate) => candidate.available) ?? hits[0];
  return hit
    ? { workspaceId: hit.workspaceId, projectId: hit.projectId }
    : null;
}

export function parseCreatedWorktree(
  stdout: string,
): { path: string; branch: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = unwrap(JSON.parse(trimmed));
    const o = asRecord(parsed);
    const nested = o ? asRecord(o.worktree) : null;
    const path =
      (o && stringField(o, "path", "worktree_path", "worktreePath")) ||
      (nested && stringField(nested, "path"));
    if (path?.startsWith("/")) {
      return {
        path,
        branch: (o && stringField(o, "branch")) || (nested && stringField(nested, "branch")) || "",
      };
    }
  } catch {
    /* text form: path<TAB>branch */
  }
  const [path, branch] = trimmed.split("\t");
  return path?.startsWith("/") ? { path, branch: branch ?? "" } : null;
}


function resolveScBin(): string | null {
  const candidates = [
    "sc",
    join(homedir(), ".superconductor", "bin", "sc"),
    "/usr/local/bin/sc",
    "/opt/homebrew/bin/sc",
  ];
  for (const bin of candidates) {
    const probe = Bun.spawnSync([bin, "version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (probe.exitCode === 0) return bin;
  }
  return null;
}

async function runSc(bin: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `sc ${args[0]} failed`);
  }
  return stdout;
}

function gitToplevel(cwd: string): string | null {
  const result = Bun.spawnSync(
    ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (result.exitCode !== 0) return null;
  const text = new TextDecoder().decode(result.stdout).trim();
  return text || null;
}

function findGitRepo(advertisedPaths: string[]): string | null {
  for (const path of advertisedPaths) {
    if (!path) continue;
    const top = gitToplevel(path);
    if (top) return top;
  }
  return null;
}

/** Linked git worktree next to the repo. No Superconductor required. */
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
    lastError = new TextDecoder().decode(result.stderr).trim() || lastError;
  }
  throw new Error(lastError);
}

export async function createBlankWorktree(advertisedPaths: string[]): Promise<{
  path: string;
}> {
  const scBin = resolveScBin();
  if (scBin) {
    let target: ScTarget | null = null;
    try {
      target = resolveScTarget(
        JSON.parse(await runSc(scBin, ["workspace", "list", "--json"])),
        advertisedPaths,
      );
    } catch {
      target = null;
    }
    if (target) {
      const created = parseCreatedWorktree(
        await runSc(scBin, [
          "worktree",
          "create",
          "--workspace",
          target.workspaceId,
          "--project",
          target.projectId,
          "--background",
          "--json",
        ]),
      );
      if (!created) throw new Error("Could not parse worktree create result");
      return { path: created.path };
    }
  }
  return createGitWorktree(advertisedPaths);
}
