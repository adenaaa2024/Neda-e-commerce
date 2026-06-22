/**
 * Claim Center lifecycle workflow navigation (read-only UI).
 * Single source for command bar, you-are-here header, and mobile flow position.
 */

import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  ClipboardCheck,
  Database,
  DollarSign,
  FileSearch,
  GitBranch,
  Link2,
} from "lucide-react";

import type { ClaimCenterV2PageId } from "./claim-center-v2-page-contract";

export type ClaimCenterFlowStepId =
  | "find_money"
  | "review"
  | "proof"
  | "product"
  | "references"
  | "recovery"
  | "sources";

export type ClaimCenterFlowStep = {
  id: ClaimCenterFlowStepId;
  order: number;
  label: string;
  shortLabel: string;
  href: string;
  pageId: ClaimCenterV2PageId;
  icon: LucideIcon;
  tooltip: string;
  countKey: keyof ClaimCenterFlowCounts;
  /** Lighter visual treatment (provenance, not filing gate). */
  outline?: boolean;
};

export type ClaimCenterFlowCounts = {
  find_money: number;
  review: number;
  proof: number;
  product: number;
  references: number;
  recovery: number;
  sources: number;
  /** Claims that passed every gate (Ready to File section badge). */
  ready_to_file: number;
  /** Submissions observed as filed (Filed / Tracking section badge). */
  filed: number;
};

export const CLAIM_CENTER_FLOW_STEPS: ClaimCenterFlowStep[] = [
  {
    id: "find_money",
    order: 1,
    label: "Find money",
    shortLabel: "Money",
    href: "/claim-center/opportunities",
    pageId: "opportunities",
    icon: DollarSign,
    tooltip: "Recoverable events sorted by value and deadline",
    countKey: "find_money",
  },
  {
    id: "review",
    order: 2,
    label: "Review",
    shortLabel: "Review",
    href: "/claim-center/candidates?filter=needs_review",
    pageId: "review",
    icon: ClipboardCheck,
    tooltip: "Human decisions before filing — blockers and ambiguity",
    countKey: "review",
  },
  {
    id: "proof",
    order: 3,
    label: "Proof",
    shortLabel: "Proof",
    href: "/claim-center/evidence",
    pageId: "evidence",
    icon: FileSearch,
    tooltip: "Photos, notes, and report attachments",
    countKey: "proof",
  },
  {
    id: "product",
    order: 4,
    label: "Product",
    shortLabel: "Product",
    href: "/claim-center/product-linkage",
    pageId: "product_match",
    icon: Link2,
    tooltip: "Catalog match blocking recovery",
    countKey: "product",
  },
  {
    id: "references",
    order: 5,
    label: "References",
    shortLabel: "Refs",
    href: "/claim-center/references",
    pageId: "references",
    icon: GitBranch,
    tooltip: "Amazon reference IDs and conflicts",
    countKey: "references",
  },
  {
    id: "recovery",
    order: 6,
    label: "Recovery",
    shortLabel: "Paid",
    href: "/claim-center/recovery",
    pageId: "recovery",
    icon: BadgeCheck,
    tooltip: "Observed filed and reimbursement signals",
    countKey: "recovery",
  },
  {
    id: "sources",
    order: 7,
    label: "Sources",
    shortLabel: "Sources",
    href: "/claim-center/sources",
    pageId: "sources",
    icon: Database,
    tooltip: "Generators and imports that produced this data",
    countKey: "sources",
    outline: true,
  },
];

export function getFlowStep(id: ClaimCenterFlowStepId): ClaimCenterFlowStep {
  const step = CLAIM_CENTER_FLOW_STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`Unknown flow step: ${id}`);
  return step;
}

export function getFlowStepByPageId(pageId: ClaimCenterV2PageId): ClaimCenterFlowStep | null {
  if (pageId === "home" || pageId === "pool" || pageId === "cases" || pageId === "submissions" || pageId === "policies") {
    return null;
  }
  return CLAIM_CENTER_FLOW_STEPS.find((s) => s.pageId === pageId) ?? null;
}

export function resolveFlowStepFromLocation(
  pathname: string,
  searchParams: URLSearchParams | null,
): ClaimCenterFlowStep | null {
  const path = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

  if (path === "/claim-center/review") {
    return getFlowStep("review");
  }
  if (path === "/claim-center/candidates") {
    if (searchParams?.get("filter") === "needs_review") return getFlowStep("review");
    return null;
  }
  if (path === "/claim-center/runs") return getFlowStep("sources");

  for (const step of CLAIM_CENTER_FLOW_STEPS) {
    const stepPath = step.href.split("?")[0];
    if (path === stepPath) return step;
  }
  return null;
}

export function flowStepNeighbors(step: ClaimCenterFlowStep): {
  previous: ClaimCenterFlowStep | null;
  next: ClaimCenterFlowStep | null;
} {
  const idx = CLAIM_CENTER_FLOW_STEPS.findIndex((s) => s.id === step.id);
  return {
    previous: idx > 0 ? CLAIM_CENTER_FLOW_STEPS[idx - 1]! : null,
    next: idx < CLAIM_CENTER_FLOW_STEPS.length - 1 ? CLAIM_CENTER_FLOW_STEPS[idx + 1]! : null,
  };
}

export function flowCountsFromDashboard(kpis: {
  total_active?: number;
  evidence_missing_count?: number;
  blocked_product_link_count?: number;
  observed_reimbursed_count?: number;
  observed_filed_count?: number;
  ready_to_file_count?: number;
  review_blocker_count?: number;
}, referenceConflictCount = 0, reviewBlockerCount?: number): ClaimCenterFlowCounts {
  const review =
    reviewBlockerCount ??
    kpis.review_blocker_count ??
    (kpis.blocked_product_link_count ?? 0) + referenceConflictCount + (kpis.evidence_missing_count ?? 0);

  return {
    find_money: kpis.total_active ?? 0,
    review,
    proof: kpis.evidence_missing_count ?? 0,
    product: kpis.blocked_product_link_count ?? 0,
    references: referenceConflictCount,
    recovery: kpis.observed_reimbursed_count ?? 0,
    sources: 0,
    ready_to_file: kpis.ready_to_file_count ?? 0,
    filed: kpis.observed_filed_count ?? 0,
  };
}
