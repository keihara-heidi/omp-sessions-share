import { FolderX, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashedEmpty } from "@/components/ds/feedback";
import { Skeleton } from "@/components/ui/skeleton";

export function WorkspaceSkeletons() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      {[0, 1, 2].map((item) => (
        <div key={item} className="rounded-lg border border-border bg-card p-3">
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="mt-2 h-3 w-72 max-w-full" />
        </div>
      ))}
    </div>
  );
}

export function NoWorkspaces() {
  return (
    <DashedEmpty icon={<FolderX aria-hidden />} title="No registered workspaces">
      Run /share register [path] in OMP to make a repository or folder available.
    </DashedEmpty>
  );
}

export function NoWorkspaceResults({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <DashedEmpty
      icon={<SearchX aria-hidden />}
      title="No matching workspaces"
      action={
        <Button variant="outline" size="touch-inline" onClick={onClear}>
          Clear search
        </Button>
      }
    >
      Nothing matches “{query}” across repositories, worktrees, branches, or paths.
    </DashedEmpty>
  );
}
