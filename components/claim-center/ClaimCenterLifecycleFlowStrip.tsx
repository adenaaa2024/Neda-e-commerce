"use client";

import Link from "next/link";

import { CLAIM_CENTER_FLOW_STEPS } from "@/lib/claims/center/claim-center-flow-nav";

import { useClaimCenterFlowCounts } from "./ClaimCenterFlowCountsProvider";

/** Home command board — visual lifecycle flow with live counts. */
export function ClaimCenterLifecycleFlowStrip() {
  const { counts, loading } = useClaimCenterFlowCounts();

  return (
    <section aria-label="Recovery lifecycle" className="claim-center-lifecycle-strip claim-center-card rounded-xl p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-60">Recovery lifecycle</h2>
      <ol className="flex flex-wrap items-center gap-2">
        {CLAIM_CENTER_FLOW_STEPS.map((step, index) => {
          const Icon = step.icon;
          const count = counts[step.countKey];
          const showCount = !loading && count > 0;
          return (
            <li key={step.id} className="flex items-center gap-2">
              <Link
                href={step.href}
                title={step.tooltip}
                className="claim-center-lifecycle-strip__chip inline-flex min-h-[44px] items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-all duration-150 hover:-translate-y-px hover:opacity-100 opacity-90"
              >
                <Icon className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                <span>{step.label}</span>
                {showCount ? (
                  <span className="rounded-full bg-amber-500/20 px-1.5 py-px text-[10px] font-bold tabular-nums">
                    {count > 99 ? "99+" : count}
                  </span>
                ) : null}
              </Link>
              {index < CLAIM_CENTER_FLOW_STEPS.length - 1 ? (
                <span className="hidden h-px w-4 bg-black/10 dark:bg-white/10 sm:block" aria-hidden />
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs opacity-55">Tap a step to open that queue — counts reflect your current store scope.</p>
    </section>
  );
}
