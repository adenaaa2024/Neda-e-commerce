"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Inbox, Layers, MoreHorizontal } from "lucide-react";
import { useState } from "react";

import { TASK_CENTER_ROUTES } from "@/lib/task-center/task-center-ui-contract";
import { TASK_CENTER_CARD_CLASS } from "./task-center-ui";

const PRIMARY = [
  {
    href: TASK_CENTER_ROUTES.home,
    label: "Home",
    title: "Overview of your task workload across personal, team, source, and claim queues.",
    icon: Home,
    exact: true,
  },
  {
    href: TASK_CENTER_ROUTES.my,
    label: "My",
    title: "Tasks assigned directly to you.",
    icon: Inbox,
    exact: false,
  },
  {
    href: TASK_CENTER_ROUTES.queues,
    label: "Teams",
    title: "Tasks grouped by team or access group.",
    icon: Layers,
    exact: false,
  },
] as const;

function navActive(pathname: string, href: string, exact: boolean) {
  const path = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  if (exact) return path === href;
  return path === href || path.startsWith(`${href}/`);
}

export function TaskCenterMobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <>
      {moreOpen ? (
        <div className="fixed inset-0 z-[400] lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
          />
          <div className={`${TASK_CENTER_CARD_CLASS} absolute bottom-16 left-4 right-4 p-3 shadow-xl`}>
            <p className="mb-2 text-xs font-bold uppercase opacity-60">More</p>
            <div className="flex flex-col gap-1">
              <Link
                href={TASK_CENTER_ROUTES.claims}
                title="Claim review work linked from the Claims module."
                className="min-h-[44px] rounded-lg px-3 py-2 text-sm font-medium"
                onClick={() => setMoreOpen(false)}
              >
                Claims Queue
              </Link>
              <Link
                href={TASK_CENTER_ROUTES.sources}
                title="Tasks grouped by the module or workflow that created them."
                className="min-h-[44px] rounded-lg px-3 py-2 text-sm font-medium"
                onClick={() => setMoreOpen(false)}
              >
                Source Modules
              </Link>
              <Link
                href={TASK_CENTER_ROUTES.org}
                title="Read-only organization structure preview for task routing and visibility."
                className="min-h-[44px] rounded-lg px-3 py-2 text-sm font-medium"
                onClick={() => setMoreOpen(false)}
              >
                Org Structure
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      <nav
        className="fixed bottom-0 left-0 right-0 z-[300] flex border-t border-black/10 bg-inherit/95 backdrop-blur-md dark:border-white/10 lg:hidden"
        aria-label="Task Center mobile"
      >
        {PRIMARY.map((item) => {
          const Icon = item.icon;
          const active = navActive(pathname, item.href, item.exact);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.title}
              className={`flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
                active ? "text-teal-600 dark:text-teal-300" : "opacity-70"
              }`}
            >
              <Icon className="h-5 w-5" aria-hidden />
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          className="flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold opacity-70"
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden />
          More
        </button>
      </nav>
    </>
  );
}
