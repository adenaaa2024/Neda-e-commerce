"use client";

/** @deprecated Flow navigation V1 — desktop rail removed; use ClaimCenterWorkflowBar. */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import {
  CLAIM_CENTER_RAIL_GROUPS,
  claimCenterNavLinkClass,
  isClaimCenterNavActive,
} from "./claim-center-nav-config";

export function ClaimCenterDesktopRail() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div className="hidden h-full flex-col p-3 lg:flex">
      <p className="mb-4 px-1 text-xs font-bold uppercase tracking-wide opacity-60">Claim Center</p>
      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto" aria-label="Claim Center sections">
        {CLAIM_CENTER_RAIL_GROUPS.map((group) => (
          <div key={group.id}>
            <p
              className={`mb-1.5 px-2 text-[10px] font-bold uppercase tracking-wider ${
                group.id === "admin_legacy" ? "opacity-45" : group.id === "workflow" ? "opacity-70" : "opacity-50"
              }`}
            >
              {group.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = isClaimCenterNavActive(pathname, searchParams, item);
                return (
                  <li key={item.href}>
                    <Link href={item.href} className={claimCenterNavLinkClass(active, item.external, item.legacy)}>
                      <span className="flex-1">{item.label}</span>
                      {item.legacy ? (
                        <span className="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-800 dark:text-amber-200">
                          Legacy
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
