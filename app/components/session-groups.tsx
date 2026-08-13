"use client";

import { ChevronRight, Folder, FolderGit2, GitBranch, LoaderCircle, Play, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { SessionSummary } from "@/lib/contracts";
import type { SessionGroup, WorktreeGroup } from "@/app/components/group-sessions";
import { api, postJson } from "@/app/components/api";
import { Button } from "@/components/ui/button";
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
  const [launching, setLaunching] = useState(false);

  async function launch() {
    setLaunching(true);
    try {
      await api<{ ok: true }>(
        "/api/sessions/launch",
        postJson({ worktreePath: worktree.path }),
      );
      toast.success(`Started OMP in ${worktree.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start session");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <section aria-label={`Worktree ${worktree.name}`}>
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <h3 className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium text-dim">
          <GitBranch aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{worktree.name}</span>
          {worktree.branch ? (
            <span className="min-w-0 truncate font-mono font-normal text-link">
              {worktree.branch}
            </span>
          ) : null}
          {worktree.path !== group.path && (
            <span className="hidden min-w-0 truncate font-mono font-normal text-dim sm:inline">
              {tildify(worktree.path)}
            </span>
          )}
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 w-full shrink-0 sm:ml-auto sm:min-h-7 sm:w-auto"
          onClick={launch}
          disabled={launching}
          aria-label={`Start OMP in ${worktree.name}`}
        >
          {launching ? (
            <LoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <Play aria-hidden />
          )}
          {launching ? "Starting…" : "Start"}
        </Button>
      </div>
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

function CreateWorktreeButton({ groupPath, groupName }: { groupPath: string; groupName: string }) {
  const [creating, setCreating] = useState(false);

  async function create() {
    setCreating(true);
    try {
      await api<{ ok: true; path: string }>(
        "/api/sessions/worktrees",
        postJson({ groupPath }),
      );
      toast.success(`Created worktree for ${groupName}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create worktree");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-11 shrink-0 sm:min-h-7"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void create();
      }}
      disabled={creating}
      aria-label={`Create worktree for ${groupName}`}
    >
      {creating ? (
        <LoaderCircle aria-hidden className="animate-spin" />
      ) : (
        <Plus aria-hidden />
      )}
      {creating ? "Creating…" : "New"}
    </Button>
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
        const createButton = (
          <CreateWorktreeButton groupPath={group.path} groupName={group.name} />
        );
        return (
          <details key={group.path} className="group">
            <summary className="mb-3 flex cursor-pointer list-none items-start gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 text-base font-semibold">
                  <Icon
                    aria-hidden
                    className="size-4 shrink-0 self-center text-dim"
                  />
                  <span className="truncate">{group.name}</span>
                  <span className="shrink-0 text-[11px] font-normal tabular-nums text-dim">
                    {count} {count === 1 ? "session" : "sessions"}
                  </span>
                </span>
                <span className="mt-0.5 block truncate pl-6 font-mono text-[11px] text-dim">
                  {tildify(group.path)}
                </span>
              </span>
              {createButton}
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
