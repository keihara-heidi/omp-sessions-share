import type { SessionGroupKind, SessionSummary } from "@/lib/contracts";

export type WorktreeGroup = {
  name: string;
  path: string;
  sessions: SessionSummary[];
};

export type SessionGroup = {
  kind: SessionGroupKind;
  name: string;
  path: string;
  worktrees: WorktreeGroup[];
};

function matches(query: string, ...haystacks: string[]): boolean {
  return haystacks.some((h) => h.toLowerCase().includes(query));
}

function newest(sessions: SessionSummary[]): number {
  let max = 0;
  for (const s of sessions) {
    const t = Date.parse(s.lastSeenAt);
    if (t > max) max = t;
  }
  return max;
}

/**
 * Group sessions into repository/folder → worktree → sessions, filtered by a
 * case-insensitive search query. A query matching a group's name or path
 * keeps the entire group; matching a worktree's name or path keeps that
 * entire worktree; otherwise only sessions whose title or cwd match are kept.
 * Groups, worktrees, and sessions are each ordered newest-first by the most
 * recent descendant session's lastSeenAt.
 */
export function groupSessions(
  sessions: SessionSummary[],
  query: string,
): SessionGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, SessionGroup>();
  const worktreesByPath = new Map<string, WorktreeGroup>();

  for (const session of sessions) {
    const { group, worktree } = session;
    if (
      q !== "" &&
      !matches(q, group.name, group.path) &&
      !matches(q, worktree.name, worktree.path) &&
      !matches(q, session.title, session.cwd)
    ) {
      continue;
    }
    let g = groups.get(group.path);
    if (!g) {
      g = { kind: group.kind, name: group.name, path: group.path, worktrees: [] };
      groups.set(group.path, g);
    }
    const worktreeKey = `${group.path}\0${worktree.path}`;
    let w = worktreesByPath.get(worktreeKey);
    if (!w) {
      w = { name: worktree.name, path: worktree.path, sessions: [] };
      worktreesByPath.set(worktreeKey, w);
      g.worktrees.push(w);
    }
    w.sessions.push(session);
  }

  const latestSession = (a: SessionSummary, b: SessionSummary) =>
    Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  const result = [...groups.values()];
  for (const g of result) {
    for (const w of g.worktrees) w.sessions.sort(latestSession);
    g.worktrees.sort((a, b) => newest(b.sessions) - newest(a.sessions));
  }
  result.sort(
    (a, b) =>
      newest(b.worktrees.flatMap((w) => w.sessions)) -
      newest(a.worktrees.flatMap((w) => w.sessions)),
  );
  return result;
}
