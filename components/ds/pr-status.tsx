/** Pull-request status chrome. Type and spacing live here — callers pass no className. */
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Clock,
  Eye,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  PullRequestAction,
  PullRequestReadiness,
  WorktreePullRequestStatus,
} from "@/lib/contracts";
import { BusyIcon, TouchButton } from "@/components/ds/session";
import { Badge, type BadgeVariant } from "@/components/ds/badge";
import { Skeleton } from "@/components/ui/skeleton";

type PullRequestInfo = NonNullable<WorktreePullRequestStatus["pullRequest"]>;

type ReadinessMeta = {
  label: string;
  variant: BadgeVariant;
  icon: typeof CircleCheck;
};

const READINESS: Record<PullRequestReadiness, ReadinessMeta> = {
  ready: { label: "Ready to merge", variant: "merge", icon: CircleCheck },
  merged: { label: "Merged", variant: "merge", icon: GitMerge },
  draft: { label: "Draft", variant: "neutral", icon: CircleDashed },
  checks_failed: { label: "Checks failed", variant: "destructive", icon: CircleX },
  checks_pending: { label: "Checks running", variant: "warning", icon: Clock },
  changes_requested: { label: "Changes requested", variant: "warning", icon: Eye },
  review_required: { label: "Review required", variant: "info", icon: Eye },
  conflicts: { label: "Conflicts", variant: "destructive", icon: GitMerge },
  unknown: { label: "Status unknown", variant: "neutral", icon: CircleHelp },
};

const ACTION_META: Record<
  PullRequestAction,
  { label: string; icon: typeof Wrench }
> = {
  fix_conflicts: { label: "Fix conflicts", icon: GitMerge },
  fix_checks: { label: "Fix checks", icon: Wrench },
  address_review: { label: "Address review", icon: Eye },
  resolve_comments: { label: "Resolve comments", icon: MessageSquare },
};

/** Actions applicable to this PR, in readiness-precedence order. */
export function applicableActions(pr: PullRequestInfo): PullRequestAction[] {
  const actions: PullRequestAction[] = [];
  if (pr.mergeable === "conflicting") actions.push("fix_conflicts");
  if (pr.checks.state === "failure") actions.push("fix_checks");
  if (pr.reviewDecision === "changes_requested") actions.push("address_review");
  if (pr.unresolvedThreads > 0) actions.push("resolve_comments");
  return actions;
}

function checksSummary(checks: PullRequestInfo["checks"]): string | null {
  if (checks.state === "none") return null;
  if (checks.state === "failure") return `${checks.failed} of ${checks.total} check${checks.total === 1 ? "" : "s"} failed`;
  if (checks.state === "pending") return `${checks.pending} check${checks.pending === 1 ? "" : "s"} running`;
  return "Checks passed";
}

function reviewSummary(decision: PullRequestInfo["reviewDecision"]): string | null {
  if (decision === "approved") return "Approved";
  if (decision === "changes_requested") return "Changes requested";
  if (decision === "review_required") return "Review required";
  return null;
}


function PrFact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span aria-hidden className="shrink-0 text-dim [&_svg]:size-3">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export function PrStatusSkeleton() {
  return <div aria-hidden className="border-b border-border px-3 py-2.5"><Skeleton className="h-4 w-44 max-w-full" /></div>;
}

export function PrStatusError({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <section aria-label="Pull request status unavailable" className="flex min-w-0 flex-col gap-2 border-b border-border px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1 truncate text-xs text-destructive">
          Couldn’t load pull request status
        </span>
        <TouchButton
          onClick={onRetry}
          disabled={retrying}
          aria-label="Retry loading pull request status"
        >
          <BusyIcon busy={retrying} idle={<RefreshCw aria-hidden />} />
          {retrying ? "Retrying…" : "Retry"}
        </TouchButton>
      </div>
    </section>
  );
}

export function PrStatusPanel({
  pullRequest,
  launching,
  busyAction,
  merging,
  onMerge,
  onAction,
}: {
  pullRequest: PullRequestInfo;
  launching: boolean;
  busyAction: PullRequestAction | null;
  onAction: (action: PullRequestAction) => void;
  merging: boolean;
  onMerge: () => void;
}) {
  const readiness = READINESS[pullRequest.readiness] ?? READINESS.unknown;
  const ReadinessIcon = readiness.icon;
  const checks = checksSummary(pullRequest.checks);
  const review = reviewSummary(pullRequest.reviewDecision);
  const actions = applicableActions(pullRequest);

  return (
    <section aria-label={`Pull request #${pullRequest.number}`} className="flex min-w-0 flex-col gap-2 border-b border-border px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <a
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 max-w-full flex-1 basis-48 items-center gap-1.5 text-sm font-medium text-link hover:underline"
        >
          <GitPullRequest aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0">#{pullRequest.number}</span>
          <span className="min-w-0 truncate">{pullRequest.title}</span>
        </a>
        <Badge variant={readiness.variant} size="sm">
          <ReadinessIcon aria-hidden />
          {readiness.label}
        </Badge>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <PrFact icon={<GitMerge />}>
          {pullRequest.headBranch} → {pullRequest.baseBranch}
        </PrFact>
        {checks ? <PrFact icon={<CircleCheck />}>{checks}</PrFact> : null}
        {review ? <PrFact icon={<Eye />}>{review}</PrFact> : null}
        {pullRequest.unresolvedThreads > 0 ? (
          <PrFact icon={<MessageSquare />}>
            {pullRequest.unresolvedThreads} unresolved comment
            {pullRequest.unresolvedThreads === 1 ? "" : "s"}
          </PrFact>
        ) : null}
      </div>
      {pullRequest.readiness === "ready" || actions.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
          {pullRequest.readiness === "ready" ? (
            <TouchButton
              onClick={onMerge}
              disabled={launching || merging}
              aria-label={`Merge pull request #${pullRequest.number}`}
            >
              <BusyIcon busy={merging} idle={<GitMerge aria-hidden />} />
              {merging ? "Merging…" : "Merge"}
            </TouchButton>
          ) : null}
          {actions.map((action) => {
            const meta = ACTION_META[action];
            const Icon = meta.icon;
            const busy = busyAction === action;
            return (
              <TouchButton
                key={action}
                onClick={() => onAction(action)}
                disabled={launching || merging}
                aria-label={`${meta.label} for pull request #${pullRequest.number}`}
              >
                <BusyIcon busy={busy} idle={<Icon aria-hidden />} />
                {busy ? "Starting…" : meta.label}
              </TouchButton>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
