/**
 * PHASE-CLAIM_CENTER_UNIFIED_OPPORTUNITIES_UI_V1 — unified primary navigation contract.
 *
 * Single source of truth for the 9 top-level Claim Center sections so the UI clearly
 * separates candidates, opportunities, needs-data, and ready-to-file claims.
 * Pure data + an active-route resolver. No DB, no Amazon, no AI, no claim math.
 */
import type { LucideIcon } from "lucide-react";
import {
  BadgeDollarSign,
  Boxes,
  ClipboardCheck,
  Database,
  FileCheck2,
  LayoutDashboard,
  Layers3,
  Settings2,
  TriangleAlert,
} from "lucide-react";

export type ClaimCenterPrimarySectionId =
  | "dashboard"
  | "opportunities"
  | "needs_data"
  | "ready_to_file"
  | "filed_tracking"
  | "reimbursements"
  | "product_story"
  | "data_sources"
  | "policies";

/** Semantic tone aligned to the phase color system. */
export type ClaimCenterNavTone = "neutral" | "opportunity" | "needs_data" | "ready" | "info";

export type ClaimCenterPrimarySection = {
  id: ClaimCenterPrimarySectionId;
  order: number;
  label: string;
  shortLabel: string;
  href: string;
  icon: LucideIcon;
  tone: ClaimCenterNavTone;
  description: string;
  /** Exact-match route (no descendant matching). */
  exact?: boolean;
};

export const CLAIM_CENTER_PRIMARY_SECTIONS: ClaimCenterPrimarySection[] = [
  {
    id: "dashboard",
    order: 1,
    label: "Dashboard",
    shortLabel: "Home",
    href: "/claim-center",
    icon: LayoutDashboard,
    tone: "neutral",
    description: "Recovery overview, counts, and source health.",
    exact: true,
  },
  {
    id: "opportunities",
    order: 2,
    label: "Opportunities",
    shortLabel: "Opps",
    href: "/claim-center/opportunities",
    icon: BadgeDollarSign,
    tone: "opportunity",
    description: "All potential claim events grouped by family.",
  },
  {
    id: "needs_data",
    order: 3,
    label: "Needs Data",
    shortLabel: "Needs",
    href: "/claim-center/needs-data",
    icon: TriangleAlert,
    tone: "needs_data",
    description: "Candidates blocked by missing source, price, reference, or receiving.",
  },
  {
    id: "ready_to_file",
    order: 4,
    label: "Ready to File",
    shortLabel: "Ready",
    href: "/claim-center/ready-to-file",
    icon: FileCheck2,
    tone: "ready",
    description: "Only claims that passed every gate. Seller Central copy enabled.",
  },
  {
    id: "filed_tracking",
    order: 5,
    label: "Filed / Tracking",
    shortLabel: "Filed",
    href: "/claim-center/reimbursement-tracking",
    icon: ClipboardCheck,
    tone: "info",
    description: "Filed submissions, match status, and open gaps.",
  },
  {
    id: "reimbursements",
    order: 6,
    label: "Reimbursements",
    shortLabel: "Paid",
    href: "/claim-center/recovery",
    icon: Boxes,
    tone: "info",
    description: "Observed reimbursement signals from imports.",
  },
  {
    id: "product_story",
    order: 7,
    label: "Product Story",
    shortLabel: "Story",
    href: "/claim-center/references",
    icon: Layers3,
    tone: "info",
    description: "Product identity + TRID / reference graph per candidate.",
  },
  {
    id: "data_sources",
    order: 8,
    label: "Data Sources / Coverage",
    shortLabel: "Sources",
    href: "/claim-center/data-coverage",
    icon: Database,
    tone: "info",
    description: "Which Amazon files/APIs power each claim family, and what is missing.",
  },
  {
    id: "policies",
    order: 9,
    label: "Policies / Settings",
    shortLabel: "Rules",
    href: "/claim-center/policies",
    icon: Settings2,
    tone: "neutral",
    description: "Effective intake rules, filing windows, and module gates.",
  },
];

/** Routes that belong under a primary section even though they are not the section root. */
const SECTION_ROUTE_ALIASES: Record<ClaimCenterPrimarySectionId, string[]> = {
  dashboard: [],
  opportunities: ["/claim-center/candidates", "/claim-center/preview-generators", "/claim-center/group-builder"],
  needs_data: [],
  ready_to_file: [],
  filed_tracking: ["/claim-center/reimbursement-tracking", "/claim-center/submissions", "/claim-center/cases", "/claim-center/case-review", "/claim-center/pilot-review"],
  reimbursements: ["/claim-center/recovery"],
  product_story: ["/claim-center/references", "/claim-center/product-linkage", "/claim-center/evidence"],
  data_sources: ["/claim-center/data-coverage", "/claim-center/sources", "/claim-center/runs"],
  policies: ["/claim-center/policies", "/claim-center/settings"],
};

function normalizePath(pathname: string): string {
  return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

export function resolveActivePrimarySection(pathname: string): ClaimCenterPrimarySectionId | null {
  const path = normalizePath(pathname);
  // Exact dashboard first (it would otherwise prefix-match everything).
  if (path === "/claim-center") return "dashboard";

  // Direct section root or descendant match.
  for (const s of CLAIM_CENTER_PRIMARY_SECTIONS) {
    if (s.exact) continue;
    const root = s.href;
    if (path === root || path.startsWith(`${root}/`)) return s.id;
  }
  // Alias routes.
  for (const s of CLAIM_CENTER_PRIMARY_SECTIONS) {
    const aliases = SECTION_ROUTE_ALIASES[s.id];
    for (const a of aliases) {
      if (path === a || path.startsWith(`${a}/`)) return s.id;
    }
  }
  return null;
}

/** Tailwind/badge tone class for the small section indicator. */
export function primaryNavToneClass(tone: ClaimCenterNavTone, active: boolean): string {
  if (!active) return "";
  switch (tone) {
    case "opportunity":
      return "claim-center-primary-nav__item--opportunity";
    case "needs_data":
      return "claim-center-primary-nav__item--needs-data";
    case "ready":
      return "claim-center-primary-nav__item--ready";
    case "info":
      return "claim-center-primary-nav__item--info";
    default:
      return "claim-center-primary-nav__item--neutral";
  }
}
