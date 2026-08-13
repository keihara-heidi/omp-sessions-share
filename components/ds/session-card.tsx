/** Session card chrome. Type and spacing live here — callers pass no className. */
import { CircleMinus, FolderCode, GitBranch, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TypographyBranch,
  TypographyH4,
  TypographyMuted,
  TypographyPath,
} from "@/components/ui/typography";

export function SessionCard({
  stale,
  disabled,
  busy,
  onSelect,
  onRemove,
  removeLabel,
  removing,
  title,
  path,
  branch,
  meta,
}: {
  stale: boolean;
  disabled: boolean;
  busy: boolean;
  onSelect: () => void;
  onRemove: () => void;
  removeLabel: string;
  removing: boolean;
  title: string;
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
            data-stale={stale || undefined}
            className="size-2 shrink-0 rounded-full bg-ok ring-[3px] ring-ok/25 data-stale:bg-dim data-stale:ring-0"
          />
          <span className="min-w-0 flex-1 overflow-hidden [&_h4]:block [&_h4]:truncate">
            <TypographyH4>{title}</TypographyH4>
          </span>
          <span className="shrink-0 text-xs font-medium text-primary">
            {busy ? "Opening…" : "Join"}
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <FolderCode aria-hidden className="size-3.5 shrink-0 text-dim" />
          <span className="min-w-0 truncate" dir="rtl">
            <bdi>
              <TypographyPath>{path}</TypographyPath>
            </bdi>
          </span>
        </span>
        {branch ? (
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <GitBranch aria-hidden className="size-3.5 shrink-0 text-link" />
            <TypographyBranch>{branch}</TypographyBranch>
          </span>
        ) : null}
        <TypographyMuted aria-live="polite">{meta}</TypographyMuted>
      </button>
      <div className="flex shrink-0 items-stretch border-l border-border">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-auto min-h-11 min-w-11 rounded-none text-dim hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
          disabled={removing || disabled}
          aria-label={removeLabel}
          title="Mark inactive"
        >
          {removing ? (
            <LoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <CircleMinus aria-hidden />
          )}
        </Button>
      </div>
    </div>
  );
}
