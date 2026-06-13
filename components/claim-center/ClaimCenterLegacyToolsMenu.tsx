"use client";

import Link from "next/link";
import { useState } from "react";
import { ExternalLink, Wrench } from "lucide-react";

import { MENORIX_TOUCH_MIN } from "@/components/menorix/menorix-module-ui";

import { CLAIM_CENTER_LEGACY_TOOLS } from "./claim-center-nav-config";

/**
 * Single controlled overflow for legacy surfaces — not part of workflow nav.
 */
export function ClaimCenterLegacyToolsMenu() {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-900 dark:text-amber-100 ${MENORIX_TOUCH_MIN}`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Wrench className="h-3.5 w-3.5" />
        Legacy tools
      </button>

      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[460]"
            aria-label="Close legacy tools menu"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-[470] mt-1 min-w-[240px] rounded-xl border border-amber-500/25 bg-inherit py-1 shadow-lg"
          >
            <p className="px-3 py-2 text-[10px] font-bold uppercase tracking-wide opacity-50">
              Outside Claim Center
            </p>
            {CLAIM_CENTER_LEGACY_TOOLS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex min-h-[44px] items-center gap-2 px-3 py-2 text-sm opacity-90 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span className="flex-1">{item.label}</span>
                <span className="rounded bg-amber-500/25 px-1.5 py-0.5 text-[9px] font-bold uppercase">Legacy</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-45" />
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
