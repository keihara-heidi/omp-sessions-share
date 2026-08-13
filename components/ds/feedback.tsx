/** Feedback surfaces. Spacing/color live here — callers pass no className. */
import type { ReactNode } from "react";
import { WifiOff } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function WarnAlert({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Alert variant="warn" className="mb-4">
      <WifiOff aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function FailAlert({
  title,
  children,
  actionLabel,
  onAction,
}: {
  title: string;
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Alert variant="destructive">
      <WifiOff aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {children}
        {actionLabel && onAction ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function DashedEmpty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
