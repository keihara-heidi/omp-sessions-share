import { Download, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ds/badge";
import { BusyIcon } from "@/components/ds/session";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { TypographyH2 } from "@/components/ui/typography";
import type { PluginUpdateStatus } from "@/lib/contracts";

export function PluginUpdateCard({
  status,
  isChecking,
  isUpdating,
  onCheck,
  onUpdate,
}: {
  status?: PluginUpdateStatus;
  isChecking: boolean;
  isUpdating: boolean;
  onCheck: () => void;
  onUpdate: () => void;
}) {
  const busy = isChecking || isUpdating;
  return (
    <section aria-labelledby="system-update-heading">
      <Card size="sm">
        <CardHeader>
          <TypographyH2 id="system-update-heading">Plugin update</TypographyH2>
          <CardDescription>
            {status
              ? `Installed ${status.currentVersion}; latest ${status.latestVersion}`
              : "Check the latest published main commit"}
          </CardDescription>
          <CardAction>
            {status?.updateAvailable ? (
              <Button size="touch-inline" onClick={onUpdate} disabled={busy}>
                <BusyIcon busy={isUpdating} idle={<Download aria-hidden />} />
                {isUpdating ? "Updating…" : "Update"}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="touch-inline"
                onClick={onCheck}
                disabled={busy}
              >
                <BusyIcon busy={isChecking} idle={<RefreshCw aria-hidden />} />
                {isChecking
                  ? "Checking…"
                  : status
                    ? "Check again"
                    : "Check for updates"}
              </Button>
            )}
          </CardAction>
        </CardHeader>
        {status ? (
          <CardContent aria-live="polite">
            <Badge
              variant={status.updateAvailable ? "warning" : "success"}
              size="md"
            >
              {status.updateAvailable ? "Update available" : "Up to date"}
            </Badge>
          </CardContent>
        ) : null}
      </Card>
    </section>
  );
}
