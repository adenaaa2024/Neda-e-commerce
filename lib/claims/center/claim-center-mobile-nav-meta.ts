import type { LucideIcon } from "lucide-react";
import {
  Archive,
  BadgeCheck,
  BookOpen,
  Database,
  DollarSign,
  FileCheck2,
  FileStack,
  GitBranch,
  LayoutDashboard,
  Link2,
  ScrollText,
  TriangleAlert,
  Wallet,
} from "lucide-react";

export type ClaimCenterMoreNavMeta = {
  purpose: string;
  icon: LucideIcon;
};

const META_BY_PATH: Record<string, ClaimCenterMoreNavMeta> = {
  "/claim-center/opportunities": {
    purpose: "Recoverable events sorted by value",
    icon: DollarSign,
  },
  "/claim-center/needs-data": {
    purpose: "Candidates blocked by missing data",
    icon: TriangleAlert,
  },
  "/claim-center/ready-to-file": {
    purpose: "Claims that passed every gate",
    icon: FileCheck2,
  },
  "/claim-center/data-coverage": {
    purpose: "Source coverage per claim family",
    icon: Database,
  },
  "/claim-center/recovery": {
    purpose: "Observed reimbursement signals",
    icon: BadgeCheck,
  },
  "/claim-center/product-linkage": {
    purpose: "Catalog match blockers",
    icon: Link2,
  },
  "/claim-center/references": {
    purpose: "Amazon reference conflicts",
    icon: GitBranch,
  },
  "/claim-center/sources": {
    purpose: "Generator runs and intake health",
    icon: Database,
  },
  "/claim-center/candidates": {
    purpose: "Full opportunity pool inbox",
    icon: FileStack,
  },
  "/claim-center/case-review": {
    purpose: "Inspect pilot cases before filing",
    icon: FileStack,
  },
  "/claim-center/reimbursement-tracking": {
    purpose: "Pilot submission financial recovery status",
    icon: Wallet,
  },
  "/claim-center/pilot-review": {
    purpose: "Pilot candidate review queue",
    icon: FileStack,
  },
  "/claim-center/policies": {
    purpose: "Effective rules snapshot (read-only)",
    icon: BookOpen,
  },
  "/claim-center/cases": {
    purpose: "Legacy internal cases",
    icon: Archive,
  },
  "/claim-center/submissions": {
    purpose: "Legacy return-linked filings",
    icon: ScrollText,
  },
};

export function getClaimCenterMoreNavMeta(href: string): ClaimCenterMoreNavMeta {
  const path = href.split("?")[0] ?? href;
  return (
    META_BY_PATH[path] ?? {
      purpose: "Open this recovery queue",
      icon: LayoutDashboard,
    }
  );
}

export const CLAIM_CENTER_MOBILE_BOTTOM_META: Record<string, { icon: LucideIcon }> = {
  "/claim-center": { icon: LayoutDashboard },
  "/claim-center/candidates": { icon: BookOpen },
  "/claim-center/evidence": { icon: Database },
};
