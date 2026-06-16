"use client";

import type { ReimbursementTrackingUiPayload } from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  formatTrackingMoney,
  hasPartialMoneyData,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
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

  return (
    <section className={CLAIM_CENTER_KPI_GRID}>
      <div className={CLAIM_CENTER_KPI_CARD}>
        <p className="text-[11px] font-semibold uppercase opacity-60">Pilot submissions</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">{cards.pilot_submission_count}</p>
        <p className="mt-2 text-xs opacity-75">
          {split.removal_shipment_missing} shipment missing · {split.removal_order_discrepancy} order
          discrepancy
        </p>
        <p className="mt-1 text-[11px] opacity-60">Trusted pilot claim_submission records only</p>
      </div>

      <div className={CLAIM_CENTER_KPI_CARD}>
        <p className="text-[11px] font-semibold uppercase opacity-60">Filing readiness</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className={claimCenterBadgeTone("neutral")}>Draft {cards.draft_submissions}</span>
          <span className={claimCenterBadgeTone("info")}>
            Ready {cards.ready_for_manual_filing}
          </span>
          <span className={claimCenterBadgeTone("warning")}>Follow-up {needsFollowUp}</span>
        </div>
        <p className="mt-2 text-xs opacity-70">Internal filing states — not Amazon statuses</p>
      </div>

      <div className={CLAIM_CENTER_KPI_CARD}>
        <p className="text-[11px] font-semibold uppercase opacity-60">Estimated recoverable</p>
        <p className="mt-1 text-xl font-bold">
          <MoneyValue value={cards.estimated_recoverable_total} partial={partialMoney} />
        </p>
      </div>

      <div className={CLAIM_CENTER_KPI_CARD}>
        <p className="text-[11px] font-semibold uppercase opacity-60">Observed reimbursement</p>
        <p className="mt-1 text-xl font-bold">
          <MoneyValue value={cards.observed_reimbursement_total} />
        </p>
        <p className="mt-2 text-xs opacity-75">
          Matched {cards.matched_reimbursements} · Unmatched {cards.unmatched_submissions}
        </p>
      </div>

      <div className={CLAIM_CENTER_KPI_CARD}>
        <p className="text-[11px] font-semibold uppercase opacity-60">Open recovery gap</p>
        <p className="mt-1 text-xl font-bold">
          <MoneyValue value={cards.remaining_open_amount_total} />
        </p>
        <p className="mt-1 text-[11px] opacity-60">Known lanes only — never inferred as $0</p>
      </div>

      <div className={CLAIM_CENTER_KPI_CARD}>
        <p className="text-[11px] font-semibold uppercase opacity-60">Needs attention</p>
        <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
          {payload.needs_attention.count}
        </p>
        <p className="mt-2 text-xs opacity-75">Top reason: {payload.needs_attention.top_reason}</p>
      </div>
    </section>
  );
}
