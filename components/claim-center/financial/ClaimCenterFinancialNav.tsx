"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  CLAIM_CENTER_FINANCIAL_NAV,
  claimCenterFinancialNavActive,
  claimCenterFinancialNavLinkClass,
} from "@/lib/claims/submission/claim-reimbursement-tracking-nav";

import { CLAIM_CENTER_HUB_NAV_CLASS } from "../claim-center-ui";

/**
 * Secondary nav for pilot filing / reimbursement surfaces — keeps financial UI grouped.
 */
export function ClaimCenterFinancialNav() {
  const pathname = usePathname();

  return (
    <nav
      className={`${CLAIM_CENTER_HUB_NAV_CLASS} claim-center-financial-nav mb-6 rounded-xl border bg-black/[0.02] dark:bg-white/[0.02]`}
      aria-label="Claim Center filing and reimbursement"
    >
      <p className="w-full px-3 pt-2 text-[10px] font-bold uppercase tracking-wider opacity-50 sm:hidden">
        Filing &amp; recovery
      </p>
      {CLAIM_CENTER_FINANCIAL_NAV.map((item) => {
        const active = claimCenterFinancialNavActive(pathname, item);
        return (
          <Link
            key={item.href + item.label}
            href={item.href}
            className={claimCenterFinancialNavLinkClass(active)}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
