"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Gavel, Home, Inbox, Layers, Network } from "lucide-react";

import { TASK_CENTER_ROUTES } from "@/lib/task-center/task-center-ui-contract";

const STEPS = [
  {
    href: TASK_CENTER_ROUTES.home,
    label: "Home",
    shortLabel: "Home",
    title: "Overview of your task workload across personal, team, source, and claim queues.",
    icon: Home,
    exact: true,
  },
  {
    href: TASK_CENTER_ROUTES.my,
    label: "My Tasks",
    shortLabel: "My",
    title: "Tasks assigned directly to you.",
    icon: Inbox,
    exact: false,
  },
  {
    href: TASK_CENTER_ROUTES.queues,
    label: "Team Queues",
    shortLabel: "Teams",
    title: "Tasks grouped by team or access group.",
    icon: Layers,
    exact: false,
  },
  {
    href: TASK_CENTER_ROUTES.claims,
    label: "Claims Queue",
    shortLabel: "Claims",
    title: "Claim review work linked from the Claims module.",
    icon: Gavel,
    exact: false,
  },
  {
    href: TASK_CENTER_ROUTES.sources,
    label: "Source Modules",
    shortLabel: "Sources",
    title: "Tasks grouped by the module or workflow that created them.",
    icon: Network,
    exact: false,
  },
  {
    href: TASK_CENTER_ROUTES.org,
    label: "Org Structure",
    shortLabel: "Org",
    title: "Read-only organization structure preview for task routing and visibility.",
    icon: Building2,
    exact: false,
  },
] as const;

function isActive(pathname: string, href: string, exact: boolean): boolean {
  const path = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  if (exact) return path === href;
  return path === href || path.startsWith(`${href}/`);
}

export function TaskCenterCommandBar() {
  const pathname = usePathname();

  return (
    <div
      className="task-center-workflow-bar sticky top-0 z-20 -mx-4 border-b px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6 xl:-mx-8 xl:px-8"
      role="navigation"
      aria-label="Task Center navigation"
    >
      <div className="flex items-center gap-2 overflow-x-auto overscroll-x-contain pb-0.5 [-webkit-overflow-scrolling:touch]">
        {STEPS.map((step) => {
          const Icon = step.icon;
          const active = isActive(pathname, step.href, step.exact);
          return (
            <Link
              key={step.href}
              href={step.href}
              title={step.title}
              className={`task-center-workflow-bar__step flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${
                active ? "task-center-workflow-bar__step--active" : ""
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{step.label}</span>
              <span className="sm:hidden">{step.shortLabel}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
