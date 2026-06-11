import type { MenorixModuleNavItem } from "@/components/menorix";

/** Claim Center section navigation — shared by shell rail, tabs, and mobile bottom nav. */
export const CLAIM_CENTER_NAV_ITEMS: MenorixModuleNavItem[] = [
  { href: "/claim-center", label: "Dashboard", shortLabel: "Home", exact: true },
  { href: "/claim-center/opportunities", label: "Opportunities", shortLabel: "Money" },
  { href: "/claim-center/candidates", label: "Candidates", shortLabel: "Pool" },
  { href: "/claim-center/review", label: "Review", shortLabel: "Review" },
  { href: "/claim-center/evidence", label: "Evidence", shortLabel: "Proof" },
  { href: "/claim-center/references", label: "References", shortLabel: "TRID" },
  { href: "/claim-center/product-linkage", label: "Product link", shortLabel: "PIM" },
  { href: "/claim-center/cases", label: "Cases", shortLabel: "Cases" },
  { href: "/claim-center/submissions", label: "Submissions", shortLabel: "Filed" },
  { href: "/claim-center/recovery", label: "Recovery", shortLabel: "Paid" },
  { href: "/claim-center/runs", label: "Runs", shortLabel: "Runs" },
  { href: "/claim-center/settings", label: "Settings", shortLabel: "Setup" },
];

export const CLAIM_CENTER_MOBILE_NAV = CLAIM_CENTER_NAV_ITEMS.filter((i) =>
  ["/claim-center", "/claim-center/opportunities", "/claim-center/review", "/claim-center/candidates", "/claim-center/settings"].includes(
    i.href,
  ),
);
