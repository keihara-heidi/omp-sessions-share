"use client";

import { Folder, FolderGit2, Plus } from "lucide-react";
import type { SessionSummary } from "@/lib/contracts";
import type { SessionGroup, WorktreeGroup } from "@/app/components/group-sessions";
import { tildify, WorktreeSessionLists } from "@/app/components/session-list";
import { DeleteWorktreeButton } from "@/app/components/worktree-delete-button";
import { NewSessionButton } from "@/app/components/new-session-button";
import {
  useCreateWorktree,
  useLaunchPullRequestTask,
  useMergePullRequest,
  usePullRequestStatus,
} from "@/app/components/use-sessions";
import {
  PrStatusError,
  PrStatusPanel,
  PrStatusSkeleton,
} from "@/components/ds/pr-status";
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
  TouchButton,
  WorktreeBlock,
  WorktreeHeading,
  WorktreeToolbar,
} from "@/components/ds/session";
function PullRequestSection({
  worktree,
  enabled,
}: {
  worktree: WorktreeGroup;
  enabled: boolean;
}) {
  const status = usePullRequestStatus(worktree, enabled);
  const launchTask = useLaunchPullRequestTask(worktree);
  const merge = useMergePullRequest(worktree);

  if (!enabled) return null;
  if (status.isPending) return <PrStatusSkeleton />;
  if (status.isError)
    return (
      <PrStatusError
        onRetry={() => void status.refetch()}
        retrying={status.isRefetching}
      />
    );
  if (!status.data?.pullRequest) return null;

  return (
    <PrStatusPanel
      pullRequest={status.data.pullRequest}
      launching={launchTask.isPending}
      busyAction={launchTask.isPending ? (launchTask.variables ?? null) : null}
      onAction={(action) => launchTask.mutate(action)}
      merging={merge.isPending}
      onMerge={() => merge.mutate()}
    />
  );
}
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
    <WorktreeBlock label={`Worktree ${worktree.name}`}>
      <WorktreeToolbar>
        <WorktreeHeading
          name={worktree.name}
          branch={worktree.branch}
          path={worktree.path !== group.path ? tildify(worktree.path) : undefined}
        />
        <NewSessionButton worktree={worktree} />
        {group.kind === "repository" && worktree.path !== group.path ? <DeleteWorktreeButton group={group} worktree={worktree} /> : null}
      </WorktreeToolbar>
      <PullRequestSection
        worktree={worktree}
        enabled={group.kind === "repository" && Boolean(worktree.branch)}
      />
      <WorktreeSessionLists
        worktree={worktree}
        now={now}
        openingId={openingId}
        onSelect={onSelect}
      />
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
          (n, worktree) =>
            n + worktree.sessions.length + worktree.recentSessions.length,
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
              {group.kind === "repository" ? (
                <span className="self-center">
                  <CreateWorktreeButton groupPath={group.path} groupName={group.name} />
                </span>
              ) : null}
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
