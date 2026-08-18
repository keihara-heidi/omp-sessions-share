import type { WorktreeGroup } from "@/app/components/group-sessions";
import { Badge } from "@/components/ds/badge";

export function WorkspaceCounts({ worktree }: { worktree: WorktreeGroup }) {
  return (
    <span className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
      <span className="sm:w-20">
        <Badge variant="success" size="md" stretch>
          {worktree.sessions.length} Live
        </Badge>
      </span>
      <span className="sm:w-20">
        <Badge variant="neutral" size="md" stretch>
          {worktree.recentSessions.length} Recent
        </Badge>
      </span>
    </span>
  );
}

export function WorkspaceSessions({ worktree }: { worktree: WorktreeGroup }) {
  if (worktree.sessions.length === 0 && worktree.recentSessions.length === 0) {
    return null;
  }

  return (
    <div
      className="border-t border-border px-3 py-2"
      aria-label={`Sessions in ${worktree.name}`}
    >
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {worktree.sessions.map((session) => (
          <li key={session.id} className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ok" />
            <span
              className="min-w-0 flex-1 truncate text-xs text-foreground"
              title={session.title}
            >
              {session.title}
            </span>
            <span className="w-14 shrink-0">
              <Badge variant="success" size="xs" stretch>Live</Badge>
            </span>
          </li>
        ))}
        {worktree.recentSessions.map((session) => (
          <li key={session.id} className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-dim" />
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={session.title}
            >
              {session.title}
            </span>
            <span className="w-14 shrink-0">
              <Badge variant="neutral" size="xs" stretch>Recent</Badge>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
