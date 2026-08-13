/** Session/group chrome. Type and spacing live here — callers pass no className. */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronRight, CircleMinus, FolderCode, GitBranch, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TypographyBranch,
  TypographyCount,
  TypographyH2,
  TypographyH3,
  TypographyH4,
  TypographyMuted,
  TypographyPath,
} from "@/components/ui/typography";

export function GroupStack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-7">{children}</div>;
}

export function GroupDisclosure({ children }: { children: ReactNode }) {
  return <details className="group">{children}</details>;
}

export function GroupSummary({ children }: { children: ReactNode }) {
  return (
    <summary className="mb-3 flex cursor-pointer list-none items-start gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {children}
    </summary>
  );
}

export function GroupChevron() {
  return (
    <ChevronRight
      aria-hidden
      className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
    />
  );
}

export function GroupSummaryText({ children }: { children: ReactNode }) {
  return <span className="min-w-0 flex-1">{children}</span>;
}

export function GroupTitleRow({
  icon,
  name,
  count,
}: {
  icon: ReactNode;
  name: string;
  count: number;
}) {
  return (
    <TypographyH2>
      <span className="flex items-baseline gap-2">
        <span className="size-4 shrink-0 self-center text-dim [&_svg]:size-4">
          {icon}
        </span>
        <span className="truncate">{name}</span>
        <TypographyCount>
          {count} {count === 1 ? "session" : "sessions"}
        </TypographyCount>
      </span>
    </TypographyH2>
  );
}

export function GroupPath({ children }: { children: ReactNode }) {
  return (
    <span className="mt-0.5 block pl-6">
      <TypographyPath>{children}</TypographyPath>
    </span>
  );
}

export function GroupBody({ children }: { children: ReactNode }) {
  return (
    <div className="ml-2 flex flex-col gap-4 border-l pl-3 sm:pl-4">{children}</div>
  );
}

export function WorktreeBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return <section aria-label={label}>{children}</section>;
}

export function WorktreeToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center">
      {children}
    </div>
  );
}

export function WorktreeHeading({
  name,
  branch,
  path,
}: {
  name: string;
  branch?: string;
  path?: string;
}) {
  return (
    <TypographyH3>
      <GitBranch aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
      {branch ? <TypographyBranch>{branch}</TypographyBranch> : null}
      {path ? (
        <span className="hidden sm:inline">
          <TypographyPath>{path}</TypographyPath>
        </span>
      ) : null}
    </TypographyH3>
  );
}

export function SessionItems({ children }: { children: ReactNode }) {
  return <ul className="flex list-none flex-col gap-2 p-0">{children}</ul>;
}

export function TouchButton({
  wide,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { wide?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size={wide ? "touch" : "touch-inline"}
      {...props}
    >
      {children}
    </Button>
  );
}

export function BusyIcon({ busy, idle }: { busy: boolean; idle: ReactNode }) {
  return busy ? <LoaderCircle aria-hidden className="animate-spin" /> : idle;
}

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

export function SessionSkeletonList() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="mt-2 h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function LoginCard({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-sm rounded-xl bg-card py-4 text-sm text-card-foreground ring-1 ring-foreground/10">
      {children}
    </div>
  );
}

export function LoginCardHeader({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1 px-4">{children}</div>;
}

export function LoginCardBody({ children }: { children: ReactNode }) {
  return <div className="px-4 pt-4">{children}</div>;
}
