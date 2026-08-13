"use client";

import { Folder, FolderGit2, Play, Plus } from "lucide-react";
import type { SessionSummary } from "@/lib/contracts";
import type { SessionGroup, WorktreeGroup } from "@/app/components/group-sessions";
import { SessionButton, tildify } from "@/app/components/session-list";
import {
  useCreateWorktree,
  useLaunchSession,
} from "@/app/components/use-sessions";
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
  const launch = useLaunchSession(worktree);

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
          primary
          onClick={() => launch.mutate()}
          disabled={launch.isPending}
          aria-label={`Start a new OMP session in ${worktree.name}`}
        >
          <BusyIcon busy={launch.isPending} idle={<Play aria-hidden />} />
          {launch.isPending ? "Starting…" : "New session"}
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
  const create = useCreateWorktree(groupPath, groupName);

  return (
    <TouchButton
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        create.mutate();
      }}
      disabled={create.isPending}
      aria-label={`Create worktree for ${groupName}`}
    >
      <BusyIcon busy={create.isPending} idle={<Plus aria-hidden />} />
      {create.isPending ? "Creating…" : "New"}
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
          (n, worktree) => n + worktree.sessions.length,
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
              <span className="self-center">
                <CreateWorktreeButton
                  groupPath={group.path}
                  groupName={group.name}
                />
              </span>
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
