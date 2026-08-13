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


