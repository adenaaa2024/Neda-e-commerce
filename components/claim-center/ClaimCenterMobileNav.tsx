"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  ClipboardCheck,
  FileSearch,
  LayoutDashboard,
  LayoutGrid,
  MoreHorizontal,
  X,
} from "lucide-react";

import { MENORIX_MODULE_BOTTOM_NAV_CLASS, MENORIX_TOUCH_MIN, menorixModuleBottomNavLinkClass } from "@/components/menorix";
import { getClaimCenterMoreNavMeta } from "@/lib/claims/center/claim-center-mobile-nav-meta";

import {
  CLAIM_CENTER_MOBILE_BOTTOM,
  CLAIM_CENTER_MOBILE_MORE_GROUPS,
  claimCenterMoreNavItems,
  isClaimCenterNavActive,
} from "./claim-center-nav-config";

const BOTTOM_ICONS: Record<string, typeof LayoutDashboard> = {
  Home: LayoutDashboard,
  Review: ClipboardCheck,
  Proof: FileSearch,
};

export function ClaimCenterMobileNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreItems = claimCenterMoreNavItems();

  const moreActive = moreItems.some((item) => isClaimCenterNavActive(pathname, searchParams, item));

  return (
    <>
      <nav className={MENORIX_MODULE_BOTTOM_NAV_CLASS} aria-label="Claim Center mobile navigation">
        {CLAIM_CENTER_MOBILE_BOTTOM.map((item) => {
          const active = isClaimCenterNavActive(pathname, searchParams, item);
          const Icon = BOTTOM_ICONS[item.shortLabel ?? item.label] ?? LayoutDashboard;
          return (
            <Link key={item.href} href={item.href} className={menorixModuleBottomNavLinkClass(active)}>
              <Icon className="h-5 w-5" aria-hidden />
              <span>{item.shortLabel ?? item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={menorixModuleBottomNavLinkClass(moreActive || moreOpen)}
          onClick={() => setMoreOpen(true)}
          aria-label="More sections"
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>More</span>
        </button>
      </nav>

      {moreOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[480] bg-black/40 lg:hidden"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
          />
          <div
            className="claim-center-mobile-more-sheet menorix-module-filter-sheet fixed inset-x-0 bottom-0 z-[485] max-h-[85vh] rounded-t-2xl border-t shadow-2xl lg:hidden"
            data-claim-center="mobile-more-sheet"
            role="dialog"
            aria-label="More Claim Center sections"
          >
            <div className="flex items-center justify-center pt-2">
              <span className="h-1 w-10 rounded-full bg-black/20 dark:bg-white/20" aria-hidden />
            </div>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <LayoutGrid className="h-4 w-4 opacity-60" />
                <h2 className="text-sm font-bold">More</h2>
              </div>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className={`rounded-lg p-2 ${MENORIX_TOUCH_MIN}`}
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-3 py-3 pb-[max(5rem,env(safe-area-inset-bottom))]">
              {CLAIM_CENTER_MOBILE_MORE_GROUPS.map((group) => (
                <div key={group.id} className="mb-5 last:mb-0">
                  <p
                    className={`mb-2 px-2 text-[10px] font-bold uppercase tracking-wider ${
                      group.id === "admin_legacy" ? "opacity-45" : "opacity-55"
                    }`}
                  >
                    {group.label}
                  </p>
                  <ul className="space-y-1">
                    {group.items.map((item) => {
                      const active = isClaimCenterNavActive(pathname, searchParams, item);
                      const meta = getClaimCenterMoreNavMeta(item.href);
                      const ItemIcon = meta.icon;
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={() => setMoreOpen(false)}
                            className={`claim-center-mobile-more-sheet__item flex min-h-[52px] items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                              active ? "menorix-module-rail__link--active bg-black/5 dark:bg-white/5" : "opacity-90 hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                            } ${item.legacy ? "opacity-75" : ""}`}
                          >
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] dark:bg-white/[0.06]">
                              <ItemIcon className="h-4 w-4 opacity-80" aria-hidden />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold leading-tight">{item.label}</span>
                              <span className="mt-0.5 block text-[11px] opacity-55">{meta.purpose}</span>
                            </span>
                            {item.legacy ? (
                              <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-800 dark:text-amber-200">
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
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
