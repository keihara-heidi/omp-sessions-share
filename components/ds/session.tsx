/** Session/group chrome. Type and spacing live here — callers pass no className. */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronRight, GitBranch, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TypographyBranch,
  TypographyCount,
  TypographyH2,
  TypographyH3,
  TypographyPath,
} from "@/components/ui/typography";

export function GroupStack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}

export function GroupDisclosure({ children }: { children: ReactNode }) {
  return (
    <details className="group/repo overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      {children}
    </details>
  );
}

export function GroupSummary({ children }: { children: ReactNode }) {
  return (
    <summary className="flex min-h-11 cursor-pointer list-none items-start gap-2 px-3 py-2.5 touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {children}
    </summary>
  );
}

export function GroupChevron() {
  return (
    <ChevronRight
      aria-hidden
      className="mt-1 size-4 shrink-0 text-dim transition-transform group-open/repo:rotate-90"
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
      <span className="flex min-w-0 items-center gap-2">
        <span className="size-4 shrink-0 text-dim [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 truncate">{name}</span>
        <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 py-0.5">
          <TypographyCount>
            {count} {count === 1 ? "session" : "sessions"}
          </TypographyCount>
        </span>
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
    <div className="flex flex-col gap-3 border-t border-border p-3">
      {children}
    </div>
  );
}

export function WorktreeBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="overflow-hidden rounded-md border border-border bg-secondary"
    >
      {children}
    </section>
  );
}

export function WorktreeToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
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
        <span className="hidden min-w-0 sm:inline">
          <TypographyPath>{path}</TypographyPath>
        </span>
      ) : null}
    </TypographyH3>
  );
}

export function SessionItems({ children }: { children: ReactNode }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-2 sm:p-2.5">
      {children}
    </ul>
  );
}

export function TouchButton({
  wide,
  primary,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  wide?: boolean;
  primary?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={primary ? "default" : "outline"}
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
