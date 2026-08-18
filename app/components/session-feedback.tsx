import { MonitorOff, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashedEmpty, SessionSkeletonList } from "@/components/ds/feedback";

export function SessionSkeletons() {
  return <SessionSkeletonList />;
}

export function NoSessions() {
  return (
    <DashedEmpty icon={<MonitorOff aria-hidden />} title="No live or recent sessions">
      Sessions appear here after OMP reports from a registered workspace.
    </DashedEmpty>
  );
}

export function NoSessionResults({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <DashedEmpty
      icon={<SearchX aria-hidden />}
      title="No matching sessions"
      action={
        <Button variant="outline" size="touch-inline" onClick={onClear}>
          Clear search
        </Button>
      }
    >
      Nothing matches “{query}” across session titles, repositories, worktrees,
      branches, or directories.
    </DashedEmpty>
  );
}
