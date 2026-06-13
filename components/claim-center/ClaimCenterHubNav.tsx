"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { CLAIM_CENTER_HUB_NAV_CLASS, claimCenterHubLinkClass } from "./claim-center-ui";

const SECTIONS = [
  { href: "/claim-center", label: "Dashboard", exact: true },
  { href: "/claim-center/opportunities", label: "Opportunities" },
  { href: "/claim-center/candidates", label: "Candidates" },
  { href: "/claim-center/review", label: "Review" },
  { href: "/claim-center/evidence", label: "Evidence" },
  { href: "/claim-center/references", label: "References" },
  { href: "/claim-center/product-linkage", label: "Product link" },
  { href: "/claim-center/cases", label: "Cases" },
  { href: "/claim-center/submissions", label: "Submissions (legacy)" },
  { href: "/claim-center/recovery", label: "Recovery" },
  { href: "/claim-center/runs", label: "Runs" },
] as const;

export function ClaimCenterHubNav() {
  const pathname = usePathname();

  return (
    <nav className={CLAIM_CENTER_HUB_NAV_CLASS} aria-label="Claim Center sections">
      {SECTIONS.map((s) => {
        const active =
          "exact" in s && s.exact
            ? pathname === s.href
            : pathname === s.href || pathname.startsWith(`${s.href}/`);
        return (
          <Link key={s.href} href={s.href} className={claimCenterHubLinkClass(active)}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
