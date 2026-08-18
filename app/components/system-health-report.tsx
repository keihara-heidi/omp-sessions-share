import {
  CircleCheck,
  CircleHelp,
  CircleX,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ds/badge";
import { BusyIcon } from "@/components/ds/session";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { TypographyH2, TypographyMuted } from "@/components/ui/typography";
import type {
  HealthCheck,
  HealthCheckId,
  HealthLevel,
  SystemHealth,
} from "@/lib/contracts";

const LEVEL_META: Record<
  HealthLevel,
  { label: string; variant: BadgeVariant; icon: typeof CircleCheck }
> = {
  healthy: { label: "Healthy", variant: "success", icon: CircleCheck },
  warning: { label: "Warning", variant: "warning", icon: TriangleAlert },
  unavailable: { label: "Unavailable", variant: "destructive", icon: CircleX },
  unknown: { label: "Unknown", variant: "neutral", icon: CircleHelp },
};

const SECTIONS: Array<{ id: string; title: string; checks: HealthCheckId[] }> =
  [
    {
      id: "system-core-heading",
      title: "Core",
      checks: ["daemon", "runtime-version", "database"],
    },
    {
      id: "system-connectivity-heading",
      title: "Connectivity",
      checks: ["tailscale-serve", "dashboard-ingress"],
    },
    {
      id: "system-tools-heading",
      title: "Tools",
      checks: ["omp", "omp-share", "github-cli"],
    },
    {
      id: "system-power-heading",
      title: "Power",
      checks: ["sleep-inhibitor"],
    },
  ];

function overallSummary(health: SystemHealth): string {
  if (health.overall === "unavailable") {
    const n = health.checks.filter(
      (check) => check.level === "unavailable",
    ).length;
    return `${n} check${n === 1 ? "" : "s"} unavailable`;
  }
  if (health.overall === "warning") {
    const n = health.checks.filter((check) => check.level === "warning").length;
    return `${n} check${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention`;
  }
  if (health.overall === "unknown") return "Some checks couldn't run";
  return "All systems healthy";
}

function LevelBadge({
  level,
  size,
}: {
  level: HealthLevel;
  size: "sm" | "md";
}) {
  const { label, variant, icon: Icon } = LEVEL_META[level];
  return (
    <Badge variant={variant} size={size}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

function CheckRow({ check }: { check: HealthCheck }) {
  return (
    <li className="flex items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          title={check.label}
        >
          {check.label}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {check.summary}
        </span>
        {check.action ? (
          <span className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Next step:</span>{" "}
            {check.action}
          </span>
        ) : null}
      </div>
      <LevelBadge level={check.level} size="sm" />
    </li>
  );
}

export function SystemHealthReport({
  health,
  isFetching,
  onRefresh,
}: {
  health: SystemHealth;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const byId = new Map(health.checks.map((check) => [check.id, check]));
  const sections = SECTIONS.map((section) => ({
    ...section,
    checks: section.checks
      .map((id) => byId.get(id))
      .filter((check): check is HealthCheck => check !== undefined),
  })).filter((section) => section.checks.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <section aria-labelledby="system-overall-heading">
        <Card size="sm">
          <CardHeader>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <TypographyH2 id="system-overall-heading">Status</TypographyH2>
              <LevelBadge level={health.overall} size="md" />
            </div>
            <CardDescription>{overallSummary(health)}</CardDescription>
            <CardAction>
              <Button
                variant="outline"
                size="touch-inline"
                onClick={onRefresh}
                disabled={isFetching}
              >
                <BusyIcon busy={isFetching} idle={<RefreshCw aria-hidden />} />
                {isFetching ? "Refreshing…" : "Refresh"}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <TypographyMuted aria-live="polite">
              Last checked {new Date(health.checkedAt).toLocaleTimeString()}
            </TypographyMuted>
          </CardContent>
        </Card>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={section.id}>
            <Card size="sm">
              <CardHeader>
                <TypographyH2 id={section.id}>{section.title}</TypographyH2>
              </CardHeader>
              <CardContent>
                <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
                  {section.checks.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          </section>
        ))}
      </div>
    </div>
  );
}
