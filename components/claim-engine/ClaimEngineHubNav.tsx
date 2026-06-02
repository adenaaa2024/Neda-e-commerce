"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: { href: string; label: string; match?: (path: string) => boolean }[] = [
  {
    href: "/returns/claims",
    label: "Draft pool",
    match: (p) => p === "/returns/claims" || p.startsWith("/returns/claims/"),
  },
  {
    href: "/claim-engine/review-ops",
    label: "Review",
    match: (p) => p === "/claim-engine/review-ops" || p.startsWith("/claim-engine/review-ops/"),
  },
  {
    href: "/claim-engine/cases",
    label: "Cases",
    match: (p) => p === "/claim-engine/cases" || p.startsWith("/claim-engine/cases/"),
  },
  {
    href: "/claim-engine",
    label: "Submission queue",
    match: (p) => p === "/claim-engine" && !p.includes("tab="),
  },
  {
    href: "/claim-engine?tab=active",
    label: "Active",
    match: (p) => p.includes("tab=active"),
  },
  {
    href: "/claim-engine?tab=closed",
    label: "Closed",
    match: (p) => p.includes("tab=closed"),
  },
];

export function ClaimEngineHubNav({ className = "" }: { className?: string }) {
  const pathname = usePathname();
  const path = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

  return (
    <nav
      className={`flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-950/80 ${className}`}
      aria-label="Claims workflow"
    >
      {LINKS.map((item) => {
        const active = item.match ? item.match(path) : path === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              active
                ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
