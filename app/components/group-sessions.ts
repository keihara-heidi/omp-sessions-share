import Fuse from "fuse.js";
import type { SessionGroupKind, SessionSummary } from "@/lib/contracts";

export type WorktreeGroup = {
  name: string;
  path: string;
  branch?: string;
  sessions: SessionSummary[];
};

export type SessionGroup = {
  kind: SessionGroupKind;
  name: string;
  path: string;
  worktrees: WorktreeGroup[];
};


function newest(sessions: SessionSummary[]): number {
  let max = 0;
  for (const s of sessions) {
    const t = Date.parse(s.startedAt);
    if (t > max) max = t;
  }
  return max;
}

/**
 * Group sessions into repository/folder → worktree → sessions. Fuse.js lets
 * each whitespace-delimited query term match a different repo, worktree,
 * title, or path field while tolerating small spelling mistakes. Results
 * retain hierarchy and newest-started-first ordering so heartbeats do not
 * reshuffle groups on dashboard poll.
 */
export function groupSessions(
  sessions: SessionSummary[],
  query: string,
): SessionGroup[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const fuse = new Fuse(sessions, {
    keys: [
      "group.name",
      "group.path",
      "worktree.name",
      "worktree.path",
      "worktree.branch",
      "title",
      "cwd",
    ],
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 1,
  });
  const matchingIds = terms.map((term) => {
    const needle = term.toLowerCase();
    const exactIds = new Set(
      sessions
        .filter((session) =>
          [
            session.group.name,
            session.group.path,
            session.worktree.name,
            session.worktree.path,
            session.worktree.branch ?? "",
            session.title,
            session.cwd,
          ].some((value) => value.toLowerCase().includes(needle)),
        )
        .map((session) => session.id),
    );
    return exactIds.size > 0
      ? exactIds
      : new Set(fuse.search(term).map(({ item }) => item.id));
  });
  const filteredSessions =
    matchingIds.length === 0
      ? sessions
      : sessions.filter((session) =>
          matchingIds.every((ids) => ids.has(session.id)),
        );
  const groups = new Map<string, SessionGroup>();
  const worktreesByPath = new Map<string, WorktreeGroup>();

  for (const session of filteredSessions) {
    const { group, worktree } = session;
    let g = groups.get(group.path);
    if (!g) {
      g = { kind: group.kind, name: group.name, path: group.path, worktrees: [] };
      groups.set(group.path, g);
    }
    const worktreeKey = `${group.path}\0${worktree.path}`;
    let w = worktreesByPath.get(worktreeKey);
    if (!w) {
      w = {
        name: worktree.name,
        path: worktree.path,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        sessions: [],
      };
      worktreesByPath.set(worktreeKey, w);
      g.worktrees.push(w);
    }
    w.sessions.push(session);
  }

  const latestSession = (a: SessionSummary, b: SessionSummary) =>
    Date.parse(b.startedAt) - Date.parse(a.startedAt);
  const result = [...groups.values()];
  for (const g of result) {
    for (const w of g.worktrees) {
      w.sessions.sort(latestSession);
      const branch = w.sessions.find((s) => s.worktree.branch)?.worktree.branch;
      if (branch) w.branch = branch;
    }
    g.worktrees.sort((a, b) => newest(b.sessions) - newest(a.sessions));
  }
  result.sort(
    (a, b) =>
      newest(b.worktrees.flatMap((w) => w.sessions)) -
      newest(a.worktrees.flatMap((w) => w.sessions)),
  );
  return result;
}
