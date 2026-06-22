/**
 * PHASE-CLAIM-CENTER-OPPORTUNITIES-NEEDS-READY-UI-V1 — unified primary navigation contract.
 *
 * Single source of truth for the 10 top-level Claim Center sections so the UI clearly
 * separates Dashboard, Opportunities, Needs Data, Ready to File, Cases, Submissions,
 * Reimbursement Tracking, Product Story, Sources, and Rules.
 * Pure data + an active-route resolver. No DB, no Amazon, no AI, no claim math.
 */
import type { LucideIcon } from "lucide-react";
import {
  BadgeDollarSign,
  Database,
  FileCheck2,
  FileStack,
  LayoutDashboard,
  Layers3,
  ScrollText,
  Settings2,
  TriangleAlert,
  Wallet,
} from "lucide-react";

import type { ClaimCenterFlowCounts } from "./claim-center-flow-nav";

export type ClaimCenterPrimarySectionId =
  | "dashboard"
  | "opportunities"
  | "needs_data"
  | "ready_to_file"
  | "cases"
  | "submissions"
  | "reimbursement_tracking"
  | "product_story"
  | "sources"
  | "rules";

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
    id: "cases",
    order: 5,
    label: "Cases",
    shortLabel: "Cases",
    href: "/claim-center/cases",
    icon: FileStack,
    tone: "info",
    description: "Claim cases grouped for filing and review.",
  },
  {
    id: "submissions",
    order: 6,
    label: "Submissions",
    shortLabel: "Subs",
    href: "/claim-center/submissions",
    icon: ScrollText,
    tone: "info",
    description: "Filed submissions and their recorded Amazon case status.",
  },
  {
    id: "reimbursement_tracking",
    order: 7,
    label: "Reimbursement Tracking",
    shortLabel: "Tracking",
    href: "/claim-center/reimbursement-tracking",
    icon: Wallet,
    tone: "info",
    description: "Filed money, reimbursement matches, and open gaps.",
  },
  {
    id: "product_story",
    order: 8,
    label: "Product Story",
    shortLabel: "Story",
    href: "/claim-center/references",
    icon: Layers3,
    tone: "info",
    description: "Product identity + TRID / reference graph per candidate.",
  },
  {
    id: "sources",
    order: 9,
    label: "Sources",
    shortLabel: "Sources",
    href: "/claim-center/data-coverage",
    icon: Database,
    tone: "info",
    description: "Which Amazon files/APIs power each claim family, and what is missing.",
  },
  {
    id: "rules",
    order: 10,
    label: "Rules",
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
  cases: ["/claim-center/case-review", "/claim-center/pilot-review"],
  submissions: [],
  reimbursement_tracking: ["/claim-center/recovery"],
  product_story: ["/claim-center/references", "/claim-center/product-linkage", "/claim-center/evidence"],
  sources: ["/claim-center/data-coverage", "/claim-center/sources", "/claim-center/runs"],
  rules: ["/claim-center/policies", "/claim-center/settings"],
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

/**
 * Map each primary section to the flow-count key whose value is shown as its badge.
 * Pure + total over every section id so the workflow bar and smoke share one source.
 * Sections with no meaningful per-section count (dashboard, policies) return null.
 */
export function primarySectionCountKey(
  id: ClaimCenterPrimarySectionId,
): keyof ClaimCenterFlowCounts | null {
  switch (id) {
    case "opportunities":
      return "find_money";
    case "needs_data":
      return "review";
    case "ready_to_file":
      return "ready_to_file";
    case "submissions":
      return "filed";
    case "reimbursement_tracking":
      return "recovery";
    case "product_story":
      return "references";
    case "sources":
      return "sources";
    case "dashboard":
    case "cases":
    case "rules":
      return null;
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

/** Resolve the badge count for a section from a flow-counts object. */
export function primarySectionBadgeCount(
  id: ClaimCenterPrimarySectionId,
  counts: ClaimCenterFlowCounts,
): number {
  const key = primarySectionCountKey(id);
  return key ? counts[key] : 0;
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
