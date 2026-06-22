import type { ReactNode } from "react";

import type { MenorixModuleNavItem } from "@/components/menorix";

export type ClaimCenterNavLink = MenorixModuleNavItem & {
  external?: boolean;
  legacy?: boolean;
};

export type ClaimCenterNavGroupId =
  | "sections"
  | "workflow"
  | "filing_recovery"
  | "blockers"
  | "sources"
  | "admin_legacy";

export type ClaimCenterNavGroup = {
  id: ClaimCenterNavGroupId;
  label: string;
  items: ClaimCenterNavLink[];
};

/** @deprecated V2 rail removed — use CLAIM_CENTER_FLOW_STEPS in claim-center-flow-nav.ts */
export const CLAIM_CENTER_WORKFLOW_NAV: ClaimCenterNavLink[] = [
  { href: "/claim-center/opportunities", label: "Find money", shortLabel: "Money" },
  { href: "/claim-center/candidates?filter=needs_review", label: "Review", shortLabel: "Review" },
  { href: "/claim-center/evidence", label: "Proof", shortLabel: "Proof" },
  { href: "/claim-center/product-linkage", label: "Product", shortLabel: "Product" },
  { href: "/claim-center/references", label: "References", shortLabel: "Refs" },
  { href: "/claim-center/recovery", label: "Recovery", shortLabel: "Paid" },
  { href: "/claim-center/sources", label: "Sources", shortLabel: "Sources" },
];

/** Mobile bottom bar — Home · Review · Proof · More. */
export const CLAIM_CENTER_MOBILE_BOTTOM: ClaimCenterNavLink[] = [
  { href: "/claim-center", label: "Home", shortLabel: "Home", exact: true },
  {
    href: "/claim-center/candidates?filter=needs_review",
    label: "Review",
    shortLabel: "Review",
  },
  { href: "/claim-center/evidence", label: "Proof", shortLabel: "Proof" },
];

/**
 * Detail / power-user tools surfaced in the More menu. None of these hrefs is a
 * primary-nav section root, so no page appears both as a primary tab and in More.
 */
export const CLAIM_CENTER_MORE_DETAIL_TOOLS: ClaimCenterNavLink[] = [
  { href: "/claim-center/evidence", label: "Proof / evidence", shortLabel: "Proof" },
  { href: "/claim-center/product-linkage", label: "Product match blockers", shortLabel: "Product" },
  { href: "/claim-center/recovery", label: "Observed reimbursements", shortLabel: "Paid" },
  { href: "/claim-center/sources", label: "Generator runs", shortLabel: "Runs" },
];

/** Case review sub-tools (the Cases primary tab is the canonical entry). */
export const CLAIM_CENTER_CASE_TOOLS_NAV: ClaimCenterNavLink[] = [
  { href: "/claim-center/case-review", label: "Case review", shortLabel: "Cases" },
  { href: "/claim-center/pilot-review", label: "Pilot review", shortLabel: "Pilot" },
];

export const CLAIM_CENTER_POOL_NAV: ClaimCenterNavLink[] = [
  { href: "/claim-center/candidates", label: "Full candidate pool", shortLabel: "Pool" },
  { href: "/claim-center/preview-generators", label: "Preview generators", shortLabel: "Previews" },
  { href: "/claim-center/group-builder", label: "Group builder", shortLabel: "Groups" },
];

/** @deprecated split into Cases / Submissions / Reimbursement Tracking primary tabs. */
export const CLAIM_CENTER_FILING_RECOVERY_NAV: ClaimCenterNavLink[] = CLAIM_CENTER_CASE_TOOLS_NAV;

/** @deprecated opportunities + recovery are reachable via primary tabs / detail tools. */
export const CLAIM_CENTER_MORE_WORKFLOW: ClaimCenterNavLink[] = [];

/** @deprecated product-linkage moved to detail tools; references is the Product Story tab. */
export const CLAIM_CENTER_MORE_BLOCKERS: ClaimCenterNavLink[] = [
  { href: "/claim-center/product-linkage", label: "Product not matched", shortLabel: "Product" },
];

/** @deprecated generator runs moved to detail tools; coverage is the Sources tab. */
export const CLAIM_CENTER_MORE_SOURCES: ClaimCenterNavLink[] = [
  { href: "/claim-center/sources", label: "Generator runs", shortLabel: "Runs" },
];

/** @deprecated policy snapshot is now the Rules primary tab. */
export const CLAIM_CENTER_ADMIN_NAV: ClaimCenterNavLink[] = [];

/** @deprecated cases + submissions are now primary tabs. */
export const CLAIM_CENTER_LEGACY_OUTCOMES_NAV: ClaimCenterNavLink[] = [];

export const CLAIM_CENTER_LEGACY_TOOLS: ClaimCenterNavLink[] = [
  { href: "/claim-engine", label: "Claim Engine (legacy)", external: true, legacy: true },
  { href: "/claim-engine/cases", label: "Claim Engine cases (legacy)", external: true, legacy: true },
  {
    href: "/claim-engine/review-ops",
    label: "Claim Engine review ops (legacy)",
    external: true,
    legacy: true,
  },
  {
    href: "/claim-engine/report-history",
    label: "Report history (legacy)",
    external: true,
    legacy: true,
  },
  { href: "/returns/claims", label: "Returns draft pool (legacy)", external: true, legacy: true },
];

/** The 10 unified primary sections — surfaced first on the mobile More sheet so the
 * top-level Claim Center structure matches the desktop primary nav. */
export const CLAIM_CENTER_PRIMARY_SECTIONS_NAV: ClaimCenterNavLink[] = [
  { href: "/claim-center", label: "Dashboard", shortLabel: "Home", exact: true },
  { href: "/claim-center/opportunities", label: "Opportunities", shortLabel: "Opps" },
  { href: "/claim-center/needs-data", label: "Needs Data", shortLabel: "Needs" },
  { href: "/claim-center/ready-to-file", label: "Ready to File", shortLabel: "Ready" },
  { href: "/claim-center/cases", label: "Cases", shortLabel: "Cases" },
  { href: "/claim-center/submissions", label: "Submissions", shortLabel: "Subs" },
  { href: "/claim-center/reimbursement-tracking", label: "Reimbursement Tracking", shortLabel: "Tracking" },
  { href: "/claim-center/references", label: "Product Story", shortLabel: "Story" },
  { href: "/claim-center/data-coverage", label: "Sources", shortLabel: "Sources" },
  { href: "/claim-center/policies", label: "Rules", shortLabel: "Rules" },
];

/**
 * More menu groups — desktop overflow + mobile sheet.
 * The "sections" group mirrors the primary nav and is rendered ONLY on the mobile
 * sheet (the desktop More menu filters it out), so no page appears both as a desktop
 * primary tab and in the desktop More menu. The remaining groups contain only
 * non-primary detail / power-user / legacy routes.
 */
export const CLAIM_CENTER_MOBILE_MORE_GROUPS: ClaimCenterNavGroup[] = [
  { id: "sections", label: "Claim Center", items: CLAIM_CENTER_PRIMARY_SECTIONS_NAV },
  { id: "filing_recovery", label: "Case tools", items: CLAIM_CENTER_CASE_TOOLS_NAV },
  { id: "blockers", label: "Detail tools", items: CLAIM_CENTER_MORE_DETAIL_TOOLS },
  { id: "admin_legacy", label: "Power user / Legacy", items: [...CLAIM_CENTER_POOL_NAV, ...CLAIM_CENTER_LEGACY_TOOLS] },
];

/** @deprecated — desktop rail removed in flow navigation V1 */
export const CLAIM_CENTER_RAIL_GROUPS: ClaimCenterNavGroup[] = [];

/** @deprecated */
export const CLAIM_CENTER_MOBILE_MORE_WORKFLOW: ClaimCenterNavLink[] = CLAIM_CENTER_MORE_WORKFLOW;

/** @deprecated V1 */
export const CLAIM_CENTER_PRIMARY_NAV: ClaimCenterNavLink[] = CLAIM_CENTER_WORKFLOW_NAV;

/** @deprecated V1 */
export const CLAIM_CENTER_BLOCKERS_NAV: ClaimCenterNavLink[] = CLAIM_CENTER_MORE_BLOCKERS;

/** @deprecated */
export const CLAIM_CENTER_PRIMARY_LINKS: ClaimCenterNavLink[] = CLAIM_CENTER_MOBILE_MORE_GROUPS.flatMap((g) => g.items);

/** @deprecated */
export const CLAIM_CENTER_MOBILE_PRIMARY: ClaimCenterNavLink[] = CLAIM_CENTER_MOBILE_BOTTOM;

export function claimCenterMoreNavItems(): ClaimCenterNavLink[] {
  return CLAIM_CENTER_MOBILE_MORE_GROUPS.flatMap((g) => g.items);
}

/** @deprecated */
export const CLAIM_CENTER_NAV_ITEMS: MenorixModuleNavItem[] = CLAIM_CENTER_PRIMARY_LINKS;

/** @deprecated */
export const CLAIM_CENTER_MOBILE_NAV: MenorixModuleNavItem[] = CLAIM_CENTER_MOBILE_BOTTOM;

export function claimCenterHrefPath(href: string): string {
  return href.split("?")[0] ?? href;
}

export function claimCenterHrefQuery(href: string): URLSearchParams {
  const q = href.split("?")[1];
  return new URLSearchParams(q ?? "");
}

export function isClaimCenterNavActive(
  pathname: string,
  searchParams: URLSearchParams | null,
  item: ClaimCenterNavLink,
): boolean {
  const path = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  const itemPath = claimCenterHrefPath(item.href);
  const itemQuery = claimCenterHrefQuery(item.href);

  if (item.href.includes("filter=needs_review")) {
    if (path === "/claim-center/review") return true;
    if (path === "/claim-center/candidates" && searchParams?.get("filter") === "needs_review") return true;
    return false;
  }

  if (itemPath === "/claim-center/candidates" && !item.href.includes("filter=")) {
    if (path !== "/claim-center/candidates") return false;
    const f = searchParams?.get("filter");
    return !f || f === "all";
  }

  if (itemPath === "/claim-center/sources" && path === "/claim-center/runs") return true;

  if (itemPath === "/claim-center/reimbursement-tracking" && path.startsWith("/claim-center/reimbursement-tracking")) {
    return true;
  }

  if (item.exact) return path === itemPath;

  const pathMatch = path === itemPath || path.startsWith(`${itemPath}/`);
  if (!pathMatch) return false;

  if ([...itemQuery.keys()].length === 0) return true;
  for (const [k, v] of itemQuery.entries()) {
    if (searchParams?.get(k) !== v) return false;
  }
  return true;
}

export function claimCenterNavLinkClass(active: boolean, external?: boolean, legacy?: boolean): string {
  const base =
    "menorix-module-rail__link flex min-h-[44px] items-center rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150";
  if (legacy) {
    return `${base} opacity-55 hover:opacity-80${active ? " menorix-module-rail__link--active opacity-90" : ""}`;
  }
  if (external) {
    return `${base} opacity-60 hover:opacity-90${active ? " menorix-module-rail__link--active opacity-100" : ""}`;
  }
  return `${base} opacity-80 hover:opacity-100 hover:translate-x-0.5${active ? " menorix-module-rail__link--active opacity-100" : ""}`;
}

export type ClaimCenterNavIconMap = Record<string, ReactNode>;
