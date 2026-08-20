"use client";

import { FolderMinus } from "lucide-react";
import { useRemoveWorkspace } from "@/app/components/use-sessions";
import { BusyIcon } from "@/components/ds/session";
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
import { Button } from "@/components/ui/button";

export function RemoveWorkspaceButton({
  groupPath,
  groupName,
  liveSessions,
}: {
  groupPath: string;
  groupName: string;
  liveSessions: number;
}) {
  const { mutate: removeWorkspace, isPending: isRemoving } =
    useRemoveWorkspace();
  const hasLiveSessions = liveSessions > 0;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-auto min-h-11 min-w-11 text-dim hover:text-destructive"
          aria-label={`Remove ${groupName} from Workspaces`}
          disabled={isRemoving}
          onClick={(event) => event.stopPropagation()}
        >
          <BusyIcon
            busy={isRemoving}
            idle={<FolderMinus aria-hidden />}
          />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {hasLiveSessions
              ? `${groupName} has live sessions`
              : `Remove ${groupName} from Workspaces?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {hasLiveSessions
              ? "Remove its live sessions first, then try again."
              : "This unregisters the workspace and clears its recent session entries. Files, repositories, and Git worktrees on disk are not deleted."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{hasLiveSessions ? "Close" : "Cancel"}</AlertDialogCancel>
          {!hasLiveSessions ? (
            <AlertDialogAction
              variant="destructive"
              onClick={() => removeWorkspace(groupPath)}
            >
              Remove workspace
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
