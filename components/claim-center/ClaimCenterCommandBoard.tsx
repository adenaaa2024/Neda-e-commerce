"use client";

import Link from "next/link";

import { CLAIM_CENTER_COMMAND_BOARD_META } from "@/lib/claims/center/claim-center-command-board-meta";
import { CLAIM_CENTER_FLOW_STEPS } from "@/lib/claims/center/claim-center-flow-nav";
import {
  CLAIM_CENTER_MONEY_TOOLTIPS,
  formatKnownUsd,
} from "@/lib/claims/center/claim-center-money-contract";
import type { ClaimCenterDashboardKpis } from "@/lib/claims/center/claim-center-v1-types";

import { useClaimCenterFlowCounts } from "./ClaimCenterFlowCountsProvider";

type Props = {
  kpis: ClaimCenterDashboardKpis;
  referenceConflictCount?: number;
};

function stepStatusTone(count: number, stepId: string): string {
  if (count === 0 && stepId !== "sources") return "claim-center-command-board__card--clear";
  if (stepId === "recovery") return "claim-center-command-board__card--observed";
  if (stepId === "find_money" && count > 0) return "claim-center-command-board__card--money";
  if (count > 0) return "claim-center-command-board__card--active";
  return "claim-center-command-board__card--neutral";
}

function moneyLineForStep(
  stepId: string,
  kpis: ClaimCenterDashboardKpis,
): string | null {
  const m = kpis.money;
  if (stepId === "find_money") {
    if (m.potential_recovery_known_usd > 0) {
      return formatKnownUsd(m.potential_recovery_known_usd);
    }
    if (m.potential_recovery_unknown_count > 0) {
      return "Cost unknown";
    }
    return null;
  }
  if (stepId === "recovery") {
    if (m.observed_reimbursed_usd != null && m.observed_reimbursed_usd > 0) {
      return formatKnownUsd(m.observed_reimbursed_usd);
    }
    if (m.observed_reimbursed_count > 0) {
      return `${m.observed_reimbursed_count} observed`;
    }
    return "Not linked yet";
  }
  return null;
}

export function ClaimCenterCommandBoard({ kpis, referenceConflictCount = 0 }: Props) {
  const { counts, loading } = useClaimCenterFlowCounts();

  return (
    <section
      aria-label="Lifecycle command board"
      className="claim-center-command-board"
      data-claim-center="command-board"
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-60">Lifecycle command board</h2>
        <p className="text-[11px] opacity-50">Tap a step — counts reflect your store scope</p>
      </div>

      <ol className="claim-center-command-board__grid grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {CLAIM_CENTER_FLOW_STEPS.map((step, index) => {
          const Icon = step.icon;
          const meta = CLAIM_CENTER_COMMAND_BOARD_META[step.id];
          const count =
            step.id === "references" ? referenceConflictCount : counts[step.countKey];
          const showCount = !loading || count > 0;
          const moneyLine = meta.showMoney ? moneyLineForStep(step.id, kpis) : null;
          const tone = stepStatusTone(count, step.id);

          return (
            <li key={step.id} className="relative flex min-w-0 flex-col">
              {index < CLAIM_CENTER_FLOW_STEPS.length - 1 ? (
                <span
                  className="claim-center-command-board__connector pointer-events-none absolute -right-1.5 top-1/2 z-0 hidden h-px w-3 -translate-y-1/2 xl:block"
                  aria-hidden
                />
              ) : null}
              <Link
                href={step.href}
                title={step.tooltip}
                className={`claim-center-command-board__card claim-center-card group relative flex min-h-[120px] flex-1 flex-col rounded-xl border p-4 transition-all duration-150 hover:-translate-y-px hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500/50 ${tone}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] dark:bg-white/[0.06]">
                    <Icon className="h-4 w-4 opacity-80" aria-hidden />
                  </span>
                  {showCount ? (
                    <span className="claim-center-command-board__count rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums">
                      {loading ? "…" : count > 99 ? "99+" : count}
                    </span>
                  ) : null}
                </div>
                <p className="mt-3 text-sm font-semibold leading-tight">{step.label}</p>
                {moneyLine ? (
                  <p
                    className="mt-1 text-xs font-medium tabular-nums opacity-85"
                    title={
                      step.id === "find_money"
                        ? CLAIM_CENTER_MONEY_TOOLTIPS.potential_recovery
                        : CLAIM_CENTER_MONEY_TOOLTIPS.observed_reimbursement
                    }
                  >
                    {moneyLine}
                  </p>
                ) : null}
                <p className="mt-2 flex-1 text-[11px] leading-relaxed opacity-60">{meta.explanation}</p>
                <p className="mt-2 text-[11px] font-semibold text-amber-900/80 dark:text-amber-200/90">
                  {meta.nextAction} →
                </p>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
