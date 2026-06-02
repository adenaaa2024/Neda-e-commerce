"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { claimEngineSubTabClass } from "./claim-engine-ui";

type HubLink = {
  href: string;
  label: string;
  isActive: (path: string, tab: string | null) => boolean;
};

const LINKS: HubLink[] = [
  {
    href: "/returns/claims",
    label: "Draft pool",
    isActive: (p) => p === "/returns/claims" || p.startsWith("/returns/claims/"),
  },
  {
    href: "/claim-engine/review-ops",
    label: "Review",
    isActive: (p) => p === "/claim-engine/review-ops" || p.startsWith("/claim-engine/review-ops/"),
  },
  {
    href: "/claim-engine/cases",
    label: "Cases",
    isActive: (p) => p === "/claim-engine/cases" || p.startsWith("/claim-engine/cases/"),
  },
  {
    href: "/claim-engine",
    label: "Submission queue",
    isActive: (p, tab) => p === "/claim-engine" && (!tab || tab === "submission_queue"),
  },
  {
    href: "/claim-engine?tab=active",
    label: "Active",
    isActive: (p, tab) => p === "/claim-engine" && tab === "active",
  },
  {
    href: "/claim-engine?tab=closed",
    label: "Closed",
    isActive: (p, tab) => p === "/claim-engine" && tab === "closed",
  },
];

function normalizePath(pathname: string): string {
  return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

export function ClaimEngineHubNav({ className = "" }: { className?: string }) {
  const pathname = normalizePath(usePathname());
  const tab = useSearchParams().get("tab");

  return (
    <nav
      className={`flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-950/80 ${className}`}
      aria-label="Claims workflow"
    >
      {LINKS.map((item) => {
        const active = item.isActive(pathname, tab);
        return (
          <Link key={item.href} href={item.href} className={claimEngineSubTabClass(active)}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
