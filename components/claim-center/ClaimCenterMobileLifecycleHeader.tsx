"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import {
  CLAIM_CENTER_FLOW_STEPS,
  resolveFlowStepFromLocation,
} from "@/lib/claims/center/claim-center-flow-nav";

import { ClaimCenterFlowStepPill } from "./ClaimCenterWorkflowBar";
import { useClaimCenterFlowCounts } from "./ClaimCenterFlowCountsProvider";

/**
 * Mobile-only lifecycle position — current step pill + swipe-friendly step chips.
 */
export function ClaimCenterMobileLifecycleHeader() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { counts, loading } = useClaimCenterFlowCounts();
  const activeStep = resolveFlowStepFromLocation(pathname, searchParams);
  const isHome = pathname === "/claim-center" || pathname === "/claim-center/";

  return (
    <div
      className="claim-center-mobile-lifecycle lg:hidden"
      data-claim-center="mobile-lifecycle-header"
      aria-label="Current recovery step"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-wider opacity-50">You are here</p>
        {isHome ? (
          <span className="text-[11px] font-medium opacity-70">Command board</span>
        ) : activeStep ? (
          <ClaimCenterFlowStepPill stepId={activeStep.id} />
        ) : (
          <span className="text-[11px] font-medium opacity-70">Utility view</span>
        )}
      </div>

      <div
        className="claim-center-mobile-lifecycle__chips flex gap-2 overflow-x-auto overscroll-x-contain pb-1 snap-x snap-mandatory [-webkit-overflow-scrolling:touch]"
        role="list"
      >
        {CLAIM_CENTER_FLOW_STEPS.map((step) => {
          const Icon = step.icon;
          const active = activeStep?.id === step.id;
          const count = counts[step.countKey];
          const showBadge = !loading && count > 0;

          return (
            <Link
              key={step.id}
              href={step.href}
              title={step.tooltip}
              role="listitem"
              className={`claim-center-mobile-lifecycle__chip snap-start flex min-h-[44px] shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition-all duration-150 ${
                active ? "claim-center-mobile-lifecycle__chip--active" : "opacity-85 active:scale-[0.98]"
              }`}
              aria-current={active ? "step" : undefined}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{step.shortLabel}</span>
              {showBadge ? (
                <span className="rounded-full bg-amber-500/25 px-1.5 py-px text-[10px] font-bold tabular-nums">
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
