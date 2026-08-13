"use client";

import { Trash2 } from "lucide-react";
import type { SessionGroup, WorktreeGroup } from "./group-sessions";
import { useDeleteWorktree } from "./use-sessions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { BusyIcon, TouchButton } from "@/components/ds/session";

export function DeleteWorktreeButton({
  group,
  worktree,
}: {
  group: SessionGroup;
  worktree: WorktreeGroup;
}) {
  const remove = useDeleteWorktree(group.path, group.name, worktree);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <TouchButton
          wide
          danger
          disabled={remove.isPending}
          aria-label={`Delete worktree ${worktree.name}`}
        >
          <BusyIcon busy={remove.isPending} idle={<Trash2 aria-hidden />} />
          {remove.isPending ? "Deleting…" : "Delete"}
        </TouchButton>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {worktree.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the Git worktree directory. Git will refuse if it has
            uncommitted changes, and the branch will be kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            Delete worktree
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
