"use client";

import { Folder, FolderGit2, Plus } from "lucide-react";
import { useState } from "react";
import type { SessionGroup, WorktreeGroup } from "@/app/components/group-sessions";
import { DeleteWorktreeButton } from "@/app/components/worktree-delete-button";
import { FavoriteRepositoryButton } from "@/app/components/favorite-repository-button";
import { NewSessionButton } from "@/app/components/new-session-button";
import { useCreateWorktree } from "@/app/components/use-sessions";
import { PullRequestSection } from "@/app/components/pull-request-section";
import {
  WorkspaceCounts,
  WorkspaceSessions,
} from "@/app/components/workspace-sessions";
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
import { Tabs } from "@/components/ui/tabs";
import { tildify } from "@/lib/utils";

function WorktreeSection({
  group,
  worktree,
  expanded,
  openingId,
  onSelect,
}: {
  group: SessionGroup;
  worktree: WorktreeGroup;
  expanded: boolean;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const deletable = group.kind === "repository" && worktree.path !== group.path;
  return (
    <WorktreeBlock label={`Worktree ${worktree.name}`}>
      <Tabs defaultValue="live" className="gap-0">
        <WorktreeToolbar>
          <WorktreeHeading
            name={worktree.name}
            branch={worktree.branch}
            path={worktree.path !== group.path ? tildify(worktree.path) : undefined}
          />
          <WorkspaceCounts worktree={worktree} />
          <div
            className={`grid w-full gap-2 sm:flex sm:w-auto ${deletable ? "grid-cols-2" : "grid-cols-1"}`}
          >
            <NewSessionButton worktree={worktree} />
            {deletable ? (
              <DeleteWorktreeButton group={group} worktree={worktree} />
            ) : null}
          </div>
        </WorktreeToolbar>
        <PullRequestSection
          worktree={worktree}
          enabled={expanded && group.kind === "repository" && Boolean(worktree.branch)}
        />
        <WorkspaceSessions
          worktree={worktree}
          openingId={openingId}
          onSelect={onSelect}
        />
      </Tabs>
    </WorktreeBlock>
  );
}

function CreateWorktreeButton({
  groupPath,
  groupName,
}: { groupPath: string; groupName: string }) {
  const { mutate: createWorktree, isPending: isCreating } = useCreateWorktree();

  return (
    <TouchButton
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        createWorktree(groupPath);
      }}
      disabled={isCreating}
      aria-label={`Create worktree for ${groupName}`}
    >
      <BusyIcon busy={isCreating} idle={<Plus aria-hidden />} />
      {isCreating ? "Creating…" : "New"}
    </TouchButton>
  );
}

function WorkspaceGroup({
  group,
  searching,
  openingId,
  onSelect,
}: {
  group: SessionGroup;
  searching: boolean;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const expanded = searching || open;
  const live = group.worktrees.reduce((count, worktree) => count + worktree.sessions.length, 0);
  const recent = group.worktrees.reduce((count, worktree) => count + worktree.recentSessions.length, 0);
  const Icon = group.kind === "repository" ? FolderGit2 : Folder;

  return (
    <GroupDisclosure
      open={expanded}
      onToggle={(event) => {
        if (!searching) setOpen(event.currentTarget.open);
      }}
    >
      <GroupSummary>
        <GroupChevron />
        <GroupSummaryText>
          <GroupTitleRow
            icon={<Icon aria-hidden />}
            name={group.name}
            summary={`${group.worktrees.length} wt · ${live} L · ${recent} R`}
            summaryLabel={`${group.worktrees.length} worktrees, ${live} live sessions, ${recent} recent sessions`}
          />
          <GroupPath>{tildify(group.path)}</GroupPath>
        </GroupSummaryText>
        {group.kind === "repository" ? (
          <>
            <span className="self-center">
              <FavoriteRepositoryButton
                groupPath={group.path}
                groupName={group.name}
                favorite={group.favorite}
              />
            </span>
            <span className="self-center">
              <CreateWorktreeButton
                groupPath={group.path}
                groupName={group.name}
              />
            </span>
          </>
        ) : null}
      </GroupSummary>
      {expanded ? (
        <GroupBody>
          {group.worktrees.map((worktree) => (
            <WorktreeSection
              key={worktree.path}
              group={group}
              worktree={worktree}
              expanded={expanded}
              openingId={openingId}
              onSelect={onSelect}
            />
          ))}
        </GroupBody>
      ) : null}
    </GroupDisclosure>
  );
}

export function WorkspaceGroups({
  groups,
  query,
  openingId,
  onSelect,
}: {
  groups: SessionGroup[];
  query: string;
  openingId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const searching = query.trim().length > 0;
  return (
    <GroupStack>
      {groups.map((group) => (
        <WorkspaceGroup
          key={group.path}
          group={group}
          searching={searching}
          openingId={openingId}
          onSelect={onSelect}
        />
      ))}
    </GroupStack>
  );
}
