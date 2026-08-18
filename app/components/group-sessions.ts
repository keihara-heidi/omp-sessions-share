import Fuse from "fuse.js";
import type {
  DashboardLocation,
  RecentSessionSummary,
  SessionDashboard,
  SessionGroupKind,
  SessionSummary,
} from "@/lib/contracts";

export type WorktreeGroup = {
  name: string;
  path: string;
  branch?: string;
  sessions: SessionSummary[];
  /** Resumable non-live sessions remembered for this worktree, newest first. */
  recentSessions: RecentSessionSummary[];
};

export type SessionGroup = {
  kind: SessionGroupKind;
  name: string;
  path: string;
  worktrees: WorktreeGroup[];
};

export type SessionProjection = {
  live: SessionSummary[];
  recent: RecentSessionSummary[];
};

type SearchScope = "sessions" | "workspaces";

type SearchItem = DashboardLocation & {
  key: string;
  session?: SessionSummary;
  recent?: RecentSessionSummary;
  title: string;
  cwd: string;
};

function searchableValues(item: SearchItem, scope: SearchScope): string[] {
  const workspace = [
    item.group.name,
    item.group.path,
    item.worktree.name,
    item.worktree.path,
    item.worktree.branch ?? "",
  ];
  return scope === "sessions" ? [...workspace, item.title, item.cwd] : workspace;
}

function locationKey(groupPath: string, worktreePath: string): string {
  return `${groupPath}\0${worktreePath}`;
}

function knownLocations(
  sessions: SessionSummary[],
  locations: DashboardLocation[],
  recentSessions: RecentSessionSummary[],
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
  // Recent-only worktrees surface too, ordered by their newest recent.
  // Worktrees with live sessions or remembered locations keep their
  // live-derived ordering timestamp untouched.
  const liveKeys = new Set(byPath.keys());
  for (const recent of recentSessions) {
    const key = locationKey(recent.group.path, recent.worktree.path);
    if (liveKeys.has(key)) continue;
    const previous = byPath.get(key);
    const lastSessionStartedAt =
      previous && Date.parse(previous.lastSessionStartedAt) > Date.parse(recent.lastSeenAt)
        ? previous.lastSessionStartedAt
        : recent.lastSeenAt;
    byPath.set(key, {
      group: recent.group,
      worktree: recent.worktree,
      lastSessionStartedAt,
    });
  }
  return [...byPath.values()];
}

/**
 * Group remembered worktrees, their live sessions, and resumable recent
 * sessions into repository/folder → worktree → session hierarchy. Empty
 * worktrees remain searchable and actionable after their last session exits;
 * recent sessions attach under their original worktree (never a global
 * section) and surface recent-only worktrees.
 */
export function groupSessions(
  sessions: SessionSummary[],
  query: string,
  locations: DashboardLocation[] = [],
  recentSessions: RecentSessionSummary[] = [],
  scope: SearchScope = "sessions",
): SessionGroup[] {
  // A session id that is currently live is never also shown as a recent.
  const liveIds = new Set(sessions.map((session) => session.id));
  const recents = recentSessions.filter((recent) => !liveIds.has(recent.id));
  const allLocations = knownLocations(sessions, locations, recents);
  const sessionsByLocation = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = locationKey(session.group.path, session.worktree.path);
    const current = sessionsByLocation.get(key) ?? [];
    current.push(session);
    sessionsByLocation.set(key, current);
  }
  const recentsByLocation = new Map<string, RecentSessionSummary[]>();
  for (const recent of recents) {
    const key = locationKey(recent.group.path, recent.worktree.path);
    const current = recentsByLocation.get(key) ?? [];
    current.push(recent);
    recentsByLocation.set(key, current);
  }

  const items: SearchItem[] = allLocations.flatMap((location) => {
    const key = locationKey(location.group.path, location.worktree.path);
    const locationSessions = sessionsByLocation.get(key) ?? [];
    const locationRecents = recentsByLocation.get(key) ?? [];
    if (locationSessions.length === 0 && locationRecents.length === 0) {
      return [{ ...location, key, title: "", cwd: "" }];
    }
    return [
      ...locationSessions.map((session) => ({
        ...location,
        key: `${key}\0${session.id}`,
        session,
        title: session.title,
        cwd: session.cwd,
      })),
      ...locationRecents.map((recent) => ({
        ...location,
        key: `${key}\0${recent.id}`,
        recent,
        title: recent.title,
        cwd: "",
      })),
    ];
  });

  const terms = query.trim().split(/\s+/).filter(Boolean);
  const fuse = new Fuse(items, {
    keys:
      scope === "sessions"
        ? [
            "group.name",
            "group.path",
            "worktree.name",
            "worktree.path",
            "worktree.branch",
            "title",
            "cwd",
          ]
        : [
            "group.name",
            "group.path",
            "worktree.name",
            "worktree.path",
            "worktree.branch",
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
          searchableValues(item, scope).some((value) =>
            value.toLowerCase().includes(needle),
          ),
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
        recentSessions: [],
      };
      worktreesByPath.set(key, groupedWorktree);
      worktreeStartedAt.set(key, Date.parse(item.lastSessionStartedAt));
      grouped.worktrees.push(groupedWorktree);
    }
    if (item.session) groupedWorktree.sessions.push(item.session);
    if (item.recent) groupedWorktree.recentSessions.push(item.recent);
  }

  const latestSession = (a: SessionSummary, b: SessionSummary) =>
    Date.parse(b.startedAt) - Date.parse(a.startedAt);
  const groupStartedAt = new Map<string, number>();
  const result = [...groups.values()];
  for (const group of result) {
    for (const worktree of group.worktrees) {
      worktree.sessions.sort(latestSession);
      worktree.recentSessions.sort(
        (a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
      );
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

export function projectSessions(
  dashboard: SessionDashboard,
  query: string,
): SessionProjection {
  const groups = groupSessions(
    dashboard.sessions,
    query,
    dashboard.locations,
    dashboard.recentSessions,
    "sessions",
  );
  return {
    live: groups.flatMap((group) =>
      group.worktrees.flatMap((worktree) => worktree.sessions),
    ),
    recent: groups.flatMap((group) =>
      group.worktrees.flatMap((worktree) => worktree.recentSessions),
    ),
  };
}

export function projectWorkspaces(
  dashboard: SessionDashboard,
  query: string,
): SessionGroup[] {
  return groupSessions(
    dashboard.sessions,
    query,
    dashboard.locations,
    dashboard.recentSessions,
    "workspaces",
  );
}
