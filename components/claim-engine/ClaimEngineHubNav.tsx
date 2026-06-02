"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import {
  CLAIMS_SETTINGS_HREF,
  isClaimsSettingsRoute,
  normalizeAppPath,
} from "@/lib/claims-hub-routes";
import { CLAIM_ENGINE_HUB_NAV_CLASS, claimEngineSubTabClass } from "./claim-engine-ui";

type HubLink = {
  href: string;
  label: string;
  tip: string;
  isActive: (path: string, tab: string | null, settingsTab?: string | null) => boolean;
};

const LINKS: HubLink[] = [
  {
    href: "/claim-engine/inbox",
    label: "Intake",
    tip: "Raw signals from imports, removals, and Amazon reports before grouping.",
    isActive: (p) => p === "/claim-engine/inbox" || p.startsWith("/claim-engine/inbox/"),
  },
  {
    href: "/returns/claims",
    label: "Draft Pool",
    tip: "Physical-scan return items eligible for claim cases. Select and group here.",
    isActive: (p) => p === "/returns/claims" || p.startsWith("/returns/claims/"),
  },
  {
    href: "/claim-engine/review-ops",
    label: "Review",
    tip: "Import/TRID draft review — product links, evidence flags, and grouping holds.",
    isActive: (p) => p === "/claim-engine/review-ops" || p.startsWith("/claim-engine/review-ops/"),
  },
  {
    href: "/claim-engine/cases",
    label: "Cases",
    tip: "Internal claim packets with lines and evidence — promote to submission queue for PDF.",
    isActive: (p) => p === "/claim-engine/cases" || p.startsWith("/claim-engine/cases/"),
  },
  {
    href: "/claim-engine",
    label: "Submission Queue",
    tip: "PDF-ready packages awaiting marketplace filing.",
    isActive: (p, tab) => p === "/claim-engine" && (!tab || tab === "submission_queue"),
  },
  {
    href: "/claim-engine?tab=active",
    label: "Active",
    tip: "Filed claims awaiting marketplace response — submitted, investigating, or evidence requested.",
    isActive: (p, tab) => p === "/claim-engine" && tab === "active",
  },
  {
    href: "/claim-engine?tab=closed",
    label: "Closed",
    tip: "Terminal outcomes — accepted, rejected, or failed.",
    isActive: (p, tab) => p === "/claim-engine" && tab === "closed",
  },
  {
    href: "/claim-engine/report-history",
    label: "Reports",
    tip: "PDF export history and claim report archive.",
    isActive: (p) => p === "/claim-engine/report-history",
  },
  {
    href: CLAIMS_SETTINGS_HREF,
    label: "Settings",
    tip: "Claim policy, agent config, evidence defaults, and module scope.",
    isActive: (p, _tab, settingsTab) => isClaimsSettingsRoute(p, settingsTab),
  },
];

export function ClaimEngineHubNav({ className = "" }: { className?: string }) {
  const pathname = normalizeAppPath(usePathname());
  const tab = useSearchParams().get("tab");
  const settingsTab = useSearchParams().get("tab");

  return (
    <nav
      className={`${CLAIM_ENGINE_HUB_NAV_CLASS} ${className}`}
      aria-label="Claims workflow"
    >
      {LINKS.map((item) => {
        const active = item.isActive(pathname, tab, settingsTab);
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.tip}
            aria-label={`${item.label} — ${item.tip}`}
            className={`${claimEngineSubTabClass(active)} shrink-0 whitespace-nowrap`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
