import type { ClaimCenterNavLink } from "@/components/claim-center/claim-center-nav-config";
import { claimCenterHrefPath } from "@/components/claim-center/claim-center-nav-config";

/** Filing + reimbursement secondary nav under Claim Center. */
export const CLAIM_CENTER_FINANCIAL_NAV: ClaimCenterNavLink[] = [
  { href: "/claim-center", label: "Dashboard", shortLabel: "Home", exact: true },
  { href: "/claim-center/opportunities", label: "Opportunities", shortLabel: "Money" },
  { href: "/claim-center/case-review", label: "Cases", shortLabel: "Cases" },
  { href: "/claim-center/case-review", label: "Filing Packets", shortLabel: "Packets" },
  { href: "/claim-center/submissions", label: "Submissions", shortLabel: "Subs", legacy: true },
  {
    href: "/claim-center/reimbursement-tracking",
    label: "Reimbursement Tracking",
    shortLabel: "Tracking",
  },
];

export function claimCenterFinancialNavActive(pathname: string, item: ClaimCenterNavLink): boolean {
  const path = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  const itemPath = claimCenterHrefPath(item.href);
  if (item.label === "Filing Packets") {
    return false;
  }
  if (item.exact) return path === itemPath;
  return path === itemPath || path.startsWith(`${itemPath}/`);
}

export function claimCenterFinancialNavLinkClass(active: boolean): string {
  return `claim-center-hub-nav__link shrink-0 whitespace-nowrap px-3 py-2 text-xs sm:text-sm${
    active ? " claim-center-hub-nav__link--active" : ""
  }`;
}
