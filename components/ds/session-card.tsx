/** Session card chrome. Type and spacing live here — callers pass no className. */
import { CircleMinus, FolderCode, GitBranch, LoaderCircle, Milestone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TypographyBranch,
  TypographyH4,
  TypographyMuted,
  TypographyPath,
} from "@/components/ui/typography";

export type SessionPresence = "live" | "stale" | "recent";

export function SessionCard({
  presence,
  disabled,
  busy,
  onSelect,
  removal,
  actionLabel = "Join",
  busyLabel = "Opening…",
  title,
  context,
  path,
  branch,
  meta,
}: {
  presence: SessionPresence;
  disabled: boolean;
  busy: boolean;
  onSelect: () => void;
  /** Optional removal rail; omit for cards without a remove action. */
  removal?: {
    onRemove: () => void;
    label: string;
    removing: boolean;
  };
  actionLabel?: string;
  busyLabel?: string;
  title: string;
  context: string;
  path: string;
  branch?: string;
  meta: string;
}) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-border bg-card text-card-foreground">
      <button
        type="button"
        className="flex min-h-11 min-w-0 flex-1 touch-manipulation flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
        onClick={onSelect}
        disabled={disabled}
        aria-busy={busy}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            aria-hidden
            data-presence={presence}
            className="size-2 shrink-0 rounded-full bg-ok ring-[3px] ring-ok/25 data-[presence=stale]:bg-dim data-[presence=stale]:ring-0 data-[presence=recent]:border data-[presence=recent]:border-dim data-[presence=recent]:bg-transparent data-[presence=recent]:ring-0"
          />
          <span
            className="min-w-0 flex-1 overflow-hidden [&_h4]:block [&_h4]:truncate"
            title={title}
          >
            <TypographyH4>{title}</TypographyH4>
          </span>
          <span className="shrink-0 text-xs font-medium text-primary">
            {busy ? busyLabel : actionLabel}
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <Milestone aria-hidden className="size-3.5 shrink-0 text-dim" />
          <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={context}>
            {context}
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <FolderCode aria-hidden className="size-3.5 shrink-0 text-dim" />
          <span className="min-w-0 truncate" dir="rtl" title={path}>
            <bdi>
              <TypographyPath>{path}</TypographyPath>
            </bdi>
          </span>
        </span>
        {branch ? (
          <span className="flex w-full min-w-0 items-center gap-1.5" title={branch}>
            <GitBranch aria-hidden className="size-3.5 shrink-0 text-link" />
            <TypographyBranch>{branch}</TypographyBranch>
          </span>
        ) : null}
        <TypographyMuted aria-live="polite">{meta}</TypographyMuted>
      </button>
      {removal ? (
        <div className="flex shrink-0 items-stretch border-l border-border">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-auto min-h-11 min-w-11 rounded-none text-dim hover:bg-destructive/10 hover:text-destructive"
            onClick={removal.onRemove}
            disabled={removal.removing || disabled}
            aria-label={removal.label}
            title="Mark inactive"
          >
            {removal.removing ? (
              <LoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <CircleMinus aria-hidden />
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
