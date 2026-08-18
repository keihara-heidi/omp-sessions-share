"use client";

import type { WorktreeGroup } from "@/app/components/group-sessions";
import {
  useLaunchPullRequestTask,
  useMergePullRequest,
  usePullRequestStatus,
} from "@/app/components/use-sessions";
import {
  PrStatusError,
  PrStatusPanel,
  PrStatusSkeleton,
} from "@/components/ds/pr-status";

export function PullRequestSection({
  worktree,
  enabled,
}: {
  worktree: WorktreeGroup;
  enabled: boolean;
}) {
  const status = usePullRequestStatus(worktree.path, enabled);
  const {
    mutate: launchPullRequestTask,
    isPending: isLaunchingTask,
    variables: taskVariables,
  } = useLaunchPullRequestTask();
  const { mutate: mergePullRequest, isPending: isMerging } =
    useMergePullRequest();

  if (!enabled) return null;
  if (status.isPending) return <PrStatusSkeleton />;
  if (status.isError) {
    return (
      <PrStatusError
        onRetry={() => void status.refetch()}
        retrying={status.isRefetching}
      />
    );
  }
  if (!status.data?.pullRequest) return null;

  return (
    <PrStatusPanel
      pullRequest={status.data.pullRequest}
      launching={isLaunchingTask}
      busyAction={isLaunchingTask ? (taskVariables?.action ?? null) : null}
      onAction={(action) =>
        launchPullRequestTask({ worktreePath: worktree.path, action })
      }
      merging={isMerging}
      onMerge={() => mergePullRequest(worktree.path)}
    />
  );
}
