/** Session/group chrome. Type and spacing live here — callers pass no className. */
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
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

export function GroupDisclosure({
  children,
  ...props
}: Omit<ComponentProps<"details">, "className">) {
  return (
    <details
      className="group/repo overflow-hidden rounded-lg border border-border bg-card text-card-foreground"
      {...props}
    >
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
  return <span className="min-w-0 flex-1 overflow-hidden">{children}</span>;
}

export function GroupTitleRow({
  icon,
  name,
  summary,
  summaryLabel,
}: {
  icon: ReactNode;
  name: string;
  summary: string;
  summaryLabel?: string;
}) {
  return (
    <TypographyH2>
      <span className="flex w-full min-w-0 items-center gap-2 overflow-hidden">
        <span className="size-4 shrink-0 text-dim [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
        <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 py-0.5">
          <TypographyCount aria-label={summaryLabel}>{summary}</TypographyCount>
        </span>
      </span>
    </TypographyH2>
  );
}

export function GroupPath({ children }: { children: ReactNode }) {
  return (
    <span className="mt-0.5 block min-w-0 truncate pl-6">
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
      className="min-w-0 overflow-hidden rounded-md border border-border bg-secondary"
    >
      {children}
    </section>
  );
}

export function WorktreeToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
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
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {branch ? <span className="min-w-0 max-w-[45%] overflow-hidden"><TypographyBranch>{branch}</TypographyBranch></span> : null}
      {path ? (
        <span className="hidden min-w-0 max-w-[35%] overflow-hidden sm:block"><TypographyPath>{path}</TypographyPath></span>
      ) : null}
    </TypographyH3>
  );
}

export function SessionItems({ children }: { children: ReactNode }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {children}
    </ul>
  );
}

export function TouchButton({
  wide,
  primary,
  danger,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  wide?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={danger ? "destructive" : primary ? "default" : "outline"}
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
