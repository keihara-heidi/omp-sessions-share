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
  const { mutate: deleteWorktree, isPending: isDeleting } = useDeleteWorktree();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <TouchButton
          wide
          danger
          disabled={isDeleting}
          aria-label={`Delete worktree ${worktree.name}`}
        >
          <BusyIcon busy={isDeleting} idle={<Trash2 aria-hidden />} />
          {isDeleting ? "Deleting…" : "Delete"}
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
            onClick={() =>
              deleteWorktree({ groupPath: group.path, worktreePath: worktree.path })
            }
          >
            Delete worktree
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
