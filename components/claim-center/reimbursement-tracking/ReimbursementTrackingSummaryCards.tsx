"use client";

import type { ReimbursementTrackingUiPayload } from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  formatTrackingMoney,
  hasPartialMoneyData,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import { parseCogsCoverageRatio } from "@/lib/claims/submission/claim-money-lane-profit-loss-ui-contract";
import { CLAIM_CENTER_KPI_CARD, CLAIM_CENTER_KPI_GRID, claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";

type Props = {
  payload: ReimbursementTrackingUiPayload;
};

function MoneyValue({ value, partial }: { value: number | null; partial?: boolean }) {
  if (value == null) {
    return (
      <span className="text-amber-700 dark:text-amber-300" title="Unknown values are not treated as zero.">
        Unknown
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {formatTrackingMoney(value)}
      {partial ? <span className="ml-1 text-[10px] font-normal opacity-70">Partial data</span> : null}
    </span>
  );
}

export function ReimbursementTrackingSummaryCards({ payload }: Props) {
  const cards = payload.summary_cards;
  const split = payload.family_split;
  const partialMoney = hasPartialMoneyData(payload.previews);
  const needsFollowUp = payload.previews.filter((p) => p.follow_up_needed).length;
  const pl = payload.money_lane?.summary_cards;
  const cogsRatio = pl ? parseCogsCoverageRatio(pl.cogs_coverage) : null;
  const postCogsApplied = cogsRatio != null && cogsRatio.known > 0;

  return (
    <div className="space-y-4">
      <section className={CLAIM_CENTER_KPI_GRID}>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Pilot submissions</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{cards.pilot_submission_count}</p>
          <p className="mt-2 text-xs opacity-75">
            {split.removal_shipment_missing} shipment missing · {split.removal_order_discrepancy} order
            discrepancy
          </p>
        </div>

        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Filing readiness</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={claimCenterBadgeTone("neutral")}>Draft {cards.draft_submissions}</span>
            <span className={claimCenterBadgeTone("info")}>Ready {cards.ready_for_manual_filing}</span>
            <span className={claimCenterBadgeTone("warning")}>Follow-up {needsFollowUp}</span>
          </div>
        </div>

        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Needs attention</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
            {payload.needs_attention.count}
          </p>
          <p className="mt-2 text-xs opacity-75">Top reason: {payload.needs_attention.top_reason}</p>
        </div>

        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Matched reimbursements</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{cards.matched_reimbursements}</p>
          <p className="mt-2 text-xs opacity-75">Unmatched {cards.unmatched_submissions}</p>
        </div>
      </section>

      {pl ? (
        <section>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold uppercase opacity-60">
              Money lane summary{postCogsApplied ? " (post-COGS)" : ""}
            </h3>
            {postCogsApplied ? (
              <span className={claimCenterBadgeTone("success")}>Approved COGS applied</span>
            ) : null}
          </div>
          <div className={`${CLAIM_CENTER_KPI_GRID} grid-cols-2 md:grid-cols-4`}>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Approved COGS coverage</p>
              <p className="mt-1 text-lg font-bold tabular-nums">{pl.cogs_coverage}</p>
              {pl.recovery_unknown_count > 0 ? (
                <span className={claimCenterBadgeTone("warning")}>Needs COGS</span>
              ) : (
                <span className={claimCenterBadgeTone("success")}>Full coverage</span>
              )}
            </div>

            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Recovery value known</p>
              <p className="mt-1 text-sm font-semibold">
                Known {pl.recovery_known_count} · Unknown {pl.recovery_unknown_count}
              </p>
              <p className="mt-1 text-lg font-bold">
                <MoneyValue value={pl.total_recovery_value} />
              </p>
            </div>

            <div className={CLAIM_CENTER_KPI_CARD}>
              <p
                className="text-[11px] font-semibold uppercase opacity-60"
                title="Informational estimate only — sale price is never used as COGS"
              >
                Sale estimate
              </p>
              <p className="mt-1 text-lg font-bold">
                <MoneyValue value={pl.total_gross_sale_estimate} />
              </p>
              <span className={claimCenterBadgeTone("info")}>Informational</span>
            </div>

            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Amazon fees</p>
              <p className="mt-1 text-lg font-bold">
                <MoneyValue value={pl.total_amazon_fees} />
              </p>
              <p className="mt-1 text-[10px] opacity-60">Actual from report when available</p>
            </div>

            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Net settlement</p>
              <p className="mt-1 text-lg font-bold">
                <MoneyValue value={pl.total_net_settlement} />
              </p>
            </div>

            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Reimbursement matched / unknown</p>
              <p className="mt-1 text-sm font-semibold">
                Matched {pl.reimbursement_matched_count} · Unknown {pl.reimbursement_unknown_count}
              </p>
              <p className="mt-1 text-lg font-bold">
                <MoneyValue value={pl.total_observed_reimbursement} />
              </p>
            </div>

            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Open recovery gap</p>
              <p className="mt-1 text-lg font-bold">
                <MoneyValue value={pl.total_open_recovery_gap} partial={partialMoney} />
              </p>
              <p className="mt-1 text-[10px] opacity-60">Only when recovery and reimbursement are both known</p>
            </div>

            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Lost profit estimate</p>
              <p className="mt-1 text-lg font-bold">
                <MoneyValue value={pl.total_lost_profit_estimate} />
              </p>
              <p className="mt-1 text-[10px] opacity-60">
                Complete on {pl.lost_profit_complete_count}/{payload.previews.length}
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
