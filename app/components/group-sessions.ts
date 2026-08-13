import Fuse from "fuse.js";
import type {
  DashboardLocation,
  SessionGroupKind,
  SessionSummary,
} from "@/lib/contracts";

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

type SearchItem = DashboardLocation & {
  key: string;
  session?: SessionSummary;
  title: string;
  cwd: string;
};

function locationKey(groupPath: string, worktreePath: string): string {
  return `${groupPath}\0${worktreePath}`;
}

function knownLocations(
  sessions: SessionSummary[],
  locations: DashboardLocation[],
): DashboardLocation[] {
  const byPath = new Map<string, DashboardLocation>();
  for (const location of locations) {
    byPath.set(locationKey(location.group.path, location.worktree.path), location);
  }
  for (const session of sessions) {
    const key = locationKey(session.group.path, session.worktree.path);
    const previous = byPath.get(key);
    const lastSessionStartedAt =
      previous && Date.parse(previous.lastSessionStartedAt) > Date.parse(session.startedAt)
        ? previous.lastSessionStartedAt
        : session.startedAt;
    byPath.set(key, {
      group: session.group,
      worktree: session.worktree,
      lastSessionStartedAt,
    });
  }
  return [...byPath.values()];
}

/**
 * Group remembered worktrees and their live sessions into repository/folder →
 * worktree → session hierarchy. Empty worktrees remain searchable and
 * actionable after their last session exits.
 */
export function groupSessions(
  sessions: SessionSummary[],
  query: string,
  locations: DashboardLocation[] = [],
): SessionGroup[] {
  const allLocations = knownLocations(sessions, locations);
  const sessionsByLocation = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = locationKey(session.group.path, session.worktree.path);
    const current = sessionsByLocation.get(key) ?? [];
    current.push(session);
    sessionsByLocation.set(key, current);
  }

  const items: SearchItem[] = allLocations.flatMap((location) => {
    const key = locationKey(location.group.path, location.worktree.path);
    const locationSessions = sessionsByLocation.get(key) ?? [];
    if (locationSessions.length === 0) {
      return [{ ...location, key, title: "", cwd: "" }];
    }
    return locationSessions.map((session) => ({
      ...location,
      key: `${key}\0${session.id}`,
      session,
      title: session.title,
      cwd: session.cwd,
    }));
  });

  const terms = query.trim().split(/\s+/).filter(Boolean);
  const fuse = new Fuse(items, {
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
  const matchingKeys = terms.map((term) => {
    const needle = term.toLowerCase();
    const exactKeys = new Set(
      items
        .filter((item) =>
          [
            item.group.name,
            item.group.path,
            item.worktree.name,
            item.worktree.path,
            item.worktree.branch ?? "",
            item.title,
            item.cwd,
          ].some((value) => value.toLowerCase().includes(needle)),
        )
        .map((item) => item.key),
    );
    return exactKeys.size > 0
      ? exactKeys
      : new Set(fuse.search(term).map(({ item }) => item.key));
  });
  const filteredItems =
    matchingKeys.length === 0
      ? items
      : items.filter((item) => matchingKeys.every((keys) => keys.has(item.key)));

  const groups = new Map<string, SessionGroup>();
  const worktreesByPath = new Map<string, WorktreeGroup>();
  const worktreeStartedAt = new Map<string, number>();

  for (const item of filteredItems) {
    const { group, worktree } = item;
    let grouped = groups.get(group.path);
    if (!grouped) {
      grouped = { kind: group.kind, name: group.name, path: group.path, worktrees: [] };
      groups.set(group.path, grouped);
    }
    const key = locationKey(group.path, worktree.path);
    let groupedWorktree = worktreesByPath.get(key);
    if (!groupedWorktree) {
      groupedWorktree = {
        name: worktree.name,
        path: worktree.path,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        sessions: [],
      };
      worktreesByPath.set(key, groupedWorktree);
      worktreeStartedAt.set(key, Date.parse(item.lastSessionStartedAt));
      grouped.worktrees.push(groupedWorktree);
    }
    if (item.session) groupedWorktree.sessions.push(item.session);
  }

  const latestSession = (a: SessionSummary, b: SessionSummary) =>
    Date.parse(b.startedAt) - Date.parse(a.startedAt);
  const groupStartedAt = new Map<string, number>();
  const result = [...groups.values()];
  for (const group of result) {
    for (const worktree of group.worktrees) {
      worktree.sessions.sort(latestSession);
      const branch = worktree.sessions.find((session) => session.worktree.branch)
        ?.worktree.branch;
      if (branch) worktree.branch = branch;
    }
    group.worktrees.sort(
      (a, b) =>
        (worktreeStartedAt.get(locationKey(group.path, b.path)) ?? 0) -
        (worktreeStartedAt.get(locationKey(group.path, a.path)) ?? 0),
    );
    groupStartedAt.set(
      group.path,
      Math.max(
        0,
        ...group.worktrees.map(
          (worktree) =>
            worktreeStartedAt.get(locationKey(group.path, worktree.path)) ?? 0,
        ),
      ),
    );
  }
  result.sort(
    (a, b) => (groupStartedAt.get(b.path) ?? 0) - (groupStartedAt.get(a.path) ?? 0),
  );
  return result;
}
