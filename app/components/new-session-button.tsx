"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import type { WorktreeGroup } from "@/app/components/group-sessions";
import { useLaunchSession } from "@/app/components/use-sessions";
import { BusyIcon, TouchButton } from "@/components/ds/session";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export function NewSessionButton({ worktree }: { worktree: WorktreeGroup }) {
  const launch = useLaunchSession(worktree);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");

  const setDialogOpen = (next: boolean) => {
    if (launch.isPending) return;
    setOpen(next);
    if (!next) setPrompt("");
  };

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <TouchButton
          wide
          primary
          aria-label={`Start a new OMP session in ${worktree.name}`}
        >
          <Play aria-hidden />
          New session
        </TouchButton>
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Start session in {worktree.name}</DialogTitle>
          <DialogDescription>
            Optionally give OMP a task to start with.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={5}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Task prompt"
          aria-label="Task prompt"
          disabled={launch.isPending}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => setDialogOpen(false)}
            disabled={launch.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="touch"
            onClick={() =>
              launch.mutate(prompt.trim() === "" ? undefined : prompt, {
                onSuccess: () => {
                  setPrompt("");
                  setOpen(false);
                },
              })
            }
            disabled={launch.isPending}
          >
            <BusyIcon busy={launch.isPending} idle={<Play aria-hidden />} />
            {launch.isPending ? "Starting…" : "Start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
