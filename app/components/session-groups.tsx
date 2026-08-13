"use client";

import { ChevronRight, Folder, FolderGit2, GitBranch } from "lucide-react";
import type { SessionSummary } from "@/lib/contracts";
import type { SessionGroup, WorktreeGroup } from "@/app/components/group-sessions";
import { SessionButton, tildify } from "@/app/components/session-list";

function WorktreeSection({
  group,
  worktree,
  now,
  openingId,
  onSelect,
}: {
  group: SessionGroup;
  worktree: WorktreeGroup;
  now: number;
  openingId: string | null;
  onSelect: (session: SessionSummary) => void;
}) {
  return (
    <section aria-label={`Worktree ${worktree.name}`}>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{worktree.name}</span>
        {worktree.path !== group.path && (
          <span className="hidden truncate font-mono text-[11px] font-normal text-muted-foreground/70 sm:inline">
            {tildify(worktree.path)}
          </span>
        )}
      </h3>
      <ul className="flex list-none flex-col gap-2 p-0">
        {worktree.sessions.map((session) => (
          <li key={session.id}>
            <SessionButton
              session={session}
              now={now}
              openingId={openingId}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SessionGroups({
  groups,
  now,
  openingId,
  onSelect,
}: {
  groups: SessionGroup[];
  now: number;
  openingId: string | null;
  onSelect: (session: SessionSummary) => void;
}) {
  return (
    <div className="flex flex-col gap-7">
      {groups.map((group) => {
        const count = group.worktrees.reduce(
          (n, w) => n + w.sessions.length,
          0,
        );
        const Icon = group.kind === "repository" ? FolderGit2 : Folder;
        return (
          <details key={group.path} className="group" open>
            <summary className="mb-3 flex cursor-pointer list-none items-start gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 text-sm font-semibold tracking-tight">
                  <Icon
                    aria-hidden
                    className="size-4 shrink-0 self-center text-muted-foreground"
                  />
                  <span className="truncate">{group.name}</span>
                  <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
                    {count} {count === 1 ? "session" : "sessions"}
                  </span>
                </span>
                <span className="mt-0.5 block truncate pl-6 font-mono text-[11px] text-muted-foreground/70">
                  {tildify(group.path)}
                </span>
              </span>
            </summary>
            <div className="ml-2 flex flex-col gap-4 border-l pl-3 sm:pl-4">
              {group.worktrees.map((worktree) => (
                <WorktreeSection
                  key={worktree.path}
                  group={group}
                  worktree={worktree}
                  now={now}
                  openingId={openingId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
