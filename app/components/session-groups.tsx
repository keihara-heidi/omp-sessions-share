"use client";

import { Folder, FolderGit2, Play, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { SessionSummary } from "@/lib/contracts";
import type { SessionGroup, WorktreeGroup } from "@/app/components/group-sessions";
import { api, postJson } from "@/app/components/api";
import { SessionButton, tildify } from "@/app/components/session-list";
import {
  BusyIcon,
  GroupBody,
  GroupChevron,
  GroupDisclosure,
  GroupPath,
  GroupStack,
  GroupSummary,
  GroupSummaryText,
  GroupTitleRow,
  SessionItems,
  TouchButton,
  WorktreeBlock,
  WorktreeHeading,
  WorktreeToolbar,
} from "@/components/ds/session";

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
    <WorktreeBlock label={`Worktree ${worktree.name}`}>
      <WorktreeToolbar>
        <WorktreeHeading
          name={worktree.name}
          branch={worktree.branch}
          path={worktree.path !== group.path ? tildify(worktree.path) : undefined}
        />
        <TouchButton
          wide
          onClick={launch}
          disabled={launching}
          aria-label={`Start OMP in ${worktree.name}`}
        >
          <BusyIcon busy={launching} idle={<Play aria-hidden />} />
          {launching ? "Starting…" : "Start"}
        </TouchButton>
      </WorktreeToolbar>
      <SessionItems>
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
      </SessionItems>
    </WorktreeBlock>
  );
}

function CreateWorktreeButton({
  groupPath,
  groupName,
}: {
  groupPath: string;
  groupName: string;
}) {
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
    <TouchButton
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void create();
      }}
      disabled={creating}
      aria-label={`Create worktree for ${groupName}`}
    >
      <BusyIcon busy={creating} idle={<Plus aria-hidden />} />
      {creating ? "Creating…" : "New"}
    </TouchButton>
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
    <GroupStack>
      {groups.map((group) => {
        const count = group.worktrees.reduce(
          (n, w) => n + w.sessions.length,
          0,
        );
        const Icon = group.kind === "repository" ? FolderGit2 : Folder;
        return (
          <GroupDisclosure key={group.path}>
            <GroupSummary>
              <GroupChevron />
              <GroupSummaryText>
                <GroupTitleRow
                  icon={<Icon aria-hidden />}
                  name={group.name}
                  count={count}
                />
                <GroupPath>{tildify(group.path)}</GroupPath>
              </GroupSummaryText>
              <CreateWorktreeButton
                groupPath={group.path}
                groupName={group.name}
              />
            </GroupSummary>
            <GroupBody>
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
            </GroupBody>
          </GroupDisclosure>
        );
      })}
    </GroupStack>
  );
}
