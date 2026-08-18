"use client";

import { SystemHealthReport } from "@/app/components/system-health-report";
import {
  useCheckPluginUpdate,
  useSystemHealth,
  useUpdatePlugin,
} from "@/app/components/use-system-health";
import { FailAlert, WarnAlert } from "@/components/ds/feedback";
import { Page } from "@/components/ds/page";
import { Skeleton } from "@/components/ui/skeleton";

function HealthSkeletons() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <div className="rounded-xl border border-border bg-card p-4">
        <Skeleton className="h-5 w-40 max-w-full" />
        <Skeleton className="mt-2 h-3 w-56 max-w-full" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1, 2, 3].map((item) => (
          <div
            key={item}
            className="rounded-xl border border-border bg-card p-3"
          >
            <Skeleton className="h-4 w-32 max-w-full" />
            <Skeleton className="mt-2 h-3 w-48 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SystemPage() {
  const { data, failed, isFetching, isPending, offline, retry, unauthorized } =
    useSystemHealth();
  const {
    data: updateStatus,
    mutate: checkPluginUpdate,
    isPending: isCheckingPluginUpdate,
  } = useCheckPluginUpdate();
  const { mutate: updatePlugin, isPending: isUpdatingPlugin } =
    useUpdatePlugin();

  if (unauthorized) return null;

  return (
    <Page>
      {offline ? (
        <WarnAlert title="Connection lost">
          Showing the last known status. Retrying…
        </WarnAlert>
      ) : null}

      {isPending ? <HealthSkeletons /> : null}

      {failed ? (
        <FailAlert
          title="Can't check system health"
          actionLabel="Try again"
          onAction={retry}
        >
          The server is not responding. Check your connection.
        </FailAlert>
      ) : null}

      {data ? (
        <SystemHealthReport
          health={data}
          isFetching={isFetching}
          onRefresh={retry}
          updateStatus={updateStatus}
          isCheckingUpdate={isCheckingPluginUpdate}
          isUpdating={isUpdatingPlugin}
          onCheckForUpdate={() => checkPluginUpdate()}
          onUpdate={() => {
            if (updateStatus) updatePlugin(updateStatus.commit);
          }}
        />
      ) : null}
    </Page>
  );
}
