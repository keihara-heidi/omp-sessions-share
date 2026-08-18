"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Activity,
  FolderGit2,
  LogOut,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useDashboardEvents, useLogout } from "@/app/components/use-sessions";
import { PageHeader, PageTitle } from "@/components/ds/page";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DESTINATIONS: Array<{
  href: string;
  label: string;
  icon: LucideIcon;
}> = [
  { href: "/", label: "Sessions", icon: MessagesSquare },
  { href: "/workspaces/", label: "Workspaces", icon: FolderGit2 },
  { href: "/system/", label: "System", icon: Activity },
];

/** Deepest-prefix match; the root destination wins only when nothing else does. */
function activeHref(pathname: string): string {
  const match = DESTINATIONS.find(({ href }) => {
    if (href === "/") return false;
    const base = href.slice(0, -1);
    return pathname === base || pathname.startsWith(`${base}/`);
  });
  return match ? match.href : "/";
}

function DashboardLink({
  href,
  label,
  icon: Icon,
  active,
  mobile = false,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  mobile?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
        active && "bg-secondary text-foreground",
        mobile && "min-w-0 flex-1 flex-col gap-0.5 px-2 py-1 text-xs",
      )}
    >
      <Icon aria-hidden className="size-4" />
      {label}
    </Link>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { mutate: logOut, isPending: isLoggingOut } = useLogout();
  useDashboardEvents();

  const active = activeHref(pathname);
  const title = `OMP ${DESTINATIONS.find(({ href }) => href === active)?.label ?? "Sessions"}`;

  return (
    <>
      <div className="mx-auto w-full max-w-4xl px-4 pt-5 sm:px-6 sm:pt-8">
        <PageHeader>
          <div className="flex min-w-0 items-center gap-3">
            <Image
              src="/icon.svg"
              alt=""
              aria-hidden
              width={32}
              height={32}
              className="size-8 shrink-0 rounded-md"
              priority
            />
            <PageTitle kicker="on this Mac">{title}</PageTitle>
          </div>
          <nav
            aria-label="Dashboard"
            className="ml-auto hidden items-center gap-1 sm:flex"
          >
            {DESTINATIONS.map((destination) => (
              <DashboardLink
                key={destination.href}
                {...destination}
                active={destination.href === active}
              />
            ))}
          </nav>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => logOut()}
            disabled={isLoggingOut}
            aria-label="Log out"
          >
            <LogOut aria-hidden />
            <span className="hidden md:inline">Log out</span>
          </Button>
        </PageHeader>
      </div>

      {children}

      <nav
        aria-label="Dashboard"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card/95 px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur sm:hidden"
      >
        {DESTINATIONS.map((destination) => (
          <DashboardLink
            key={destination.href}
            {...destination}
            active={destination.href === active}
            mobile
          />
        ))}
      </nav>
    </>
  );
}
