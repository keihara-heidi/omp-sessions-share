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
    <div className="relative">
      <button
        type="button"
        className="flex w-full touch-manipulation flex-col gap-1.5 rounded-lg border bg-card p-4 pr-12 text-left text-card-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
        onClick={onSelect}
        disabled={disabled}
        aria-busy={busy}
      >
        <span className="flex w-full items-center gap-2">
          <span
            aria-hidden
            data-stale={stale || undefined}
            className="size-2 shrink-0 rounded-full bg-ok ring-[3px] ring-ok/25 data-stale:bg-dim data-stale:ring-0"
          />
          <TypographyH4>{title}</TypographyH4>
        </span>
        <span className="flex w-full items-center gap-1.5 truncate">
          <FolderCode aria-hidden className="size-3.5 shrink-0 text-dim" />
          <span className="truncate" dir="rtl">
            <bdi>
              <TypographyPath>{path}</TypographyPath>
            </bdi>
          </span>
        </span>
        {branch ? (
          <span className="flex w-full items-center gap-1.5 truncate">
            <GitBranch aria-hidden className="size-3.5 shrink-0 text-link" />
            <TypographyBranch>{branch}</TypographyBranch>
          </span>
        ) : null}
        <TypographyMuted aria-live="polite">{meta}</TypographyMuted>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-2 top-2 text-muted-foreground hover:text-destructive"
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
  );
}
