"use client";

import { ChevronRight } from "lucide-react";

import { IdentifierStack } from "@/components/IdentifierStack";
import type { PerSubmissionMoneyPreviewV2 } from "@/lib/claims/submission/claim-money-lane-preview-v2-profit-loss-v1";
import type { MoneyLaneUiBundle } from "@/lib/claims/submission/claim-money-lane-profit-loss-ui-contract";
import {
  MONEY_LANE_FORMULA_HELPERS,
  moneyLaneForSubmission,
  profitIfSoldFromPreview,
  reimbursementMatchStatusFromPreview,
  reimbursementMatchStatusLabel,
  reimbursementMatchStatusTone,
} from "@/lib/claims/submission/claim-money-lane-profit-loss-ui-contract";
import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  deriveNextAction,
  extractSourceTrackingLabel,
  formatTrackingMoney,
  familyTone,
  reimbursementTrackingStatusLabel,
  reimbursementTrackingStatusTone,
  shortId,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  CLAIM_CENTER_TABLE_CLASS,
  CLAIM_CENTER_TABLE_HEAD_CLASS,
  CLAIM_CENTER_TABLE_ROW_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";
import { MoneyLaneStatusBadge } from "./ReimbursementTrackingMoneyBadges";

type Props = {
  rows: ReimbursementTrackingPreviewRow[];
  selectedId: string | null;
  onSelect: (row: ReimbursementTrackingPreviewRow) => void;
  storePlatform?: string | null;
  moneyLane?: MoneyLaneUiBundle | null;
};

function MoneyCell({ value }: { value: number | null | undefined }) {
  if (value == null) {
    return (
      <span className="text-amber-700 dark:text-amber-300" title="Unknown values are not treated as zero.">
        Unknown
      </span>
    );
  }
  return <span className="tabular-nums">{formatTrackingMoney(value)}</span>;
}

function familyRowClass(family: string | null | undefined): string {
  const fam = (family ?? "").toLowerCase();
  if (fam.includes("removal_shipment_missing")) {
    return "border-l-4 border-l-violet-500/70";
  }
  if (fam.includes("removal_order_discrepancy")) {
    return "border-l-4 border-l-sky-500/70";
  }
  return "border-l-4 border-l-transparent";
}

function moneyCells(m: PerSubmissionMoneyPreviewV2 | null) {
  if (!m) {
    return {
      sold: null,
      fees: null,
      settlement: null,
      cogs: null,
      recovery: null,
      reimb: null,
      gap: null,
      profitIfSold: null,
      recoveryVsCost: null,
      lostProfit: null,
    };
  }
  return {
    sold: m.sale_view.latest_sold_price.value,
    fees: m.amazon_fee_view.estimated_amazon_fees.value,
    settlement: m.settlement_view.net_settlement_amount.value,
    cogs: m.cost_recovery_view.approved_cogs_unit.value,
    recovery: m.cost_recovery_view.recovery_value.value,
    reimb: m.reimbursement_view.observed_reimbursement.value,
    gap: m.open_gap_view.open_recovery_gap.value,
    profitIfSold: profitIfSoldFromPreview(m),
    recoveryVsCost: m.profit_loss_view.actual_recovery_vs_cost.value,
    lostProfit: m.profit_loss_view.lost_profit_estimate.value,
  };
}

export function ReimbursementTrackingTable({
  rows,
  selectedId,
  onSelect,
  storePlatform,
  moneyLane,
}: Props) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm opacity-70">
        No results match these filters. Clear filters to see all submissions.
      </p>
    );
  }

  return (
    <div className="claim-center-table-card overflow-x-auto rounded-xl border">
      <table className={`${CLAIM_CENTER_TABLE_CLASS} min-w-[1800px]`}>
        <thead className={`${CLAIM_CENTER_TABLE_HEAD_CLASS} sticky top-0 z-10 bg-[var(--claim-center-card-bg,hsl(var(--card)))] text-xs uppercase opacity-70`}>
          <tr>
            <th className="px-3 py-3 text-left">Status</th>
            <th className="px-3 py-3 text-left">Family</th>
            <th className="px-3 py-3 text-left">Case</th>
            <th className="px-3 py-3 text-left">Product</th>
            <th className="px-3 py-3 text-right">Qty</th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.sale_gross}>
              Sold price
            </th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.amazon_fees}>
              Amazon fees
            </th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.net_settlement}>
              Net settlement
            </th>
            <th
              className="px-3 py-3 text-right"
              title="approved_cogs_unit from product_cost_snapshots or cogs_overrides — never sale price"
            >
              COGS unit
            </th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.recovery}>
              Recovery
            </th>
            <th className="px-3 py-3 text-left">Reimb status</th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.observed_reimb}>
              Observed reimb
            </th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.open_gap}>
              Open gap
            </th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.profit_if_sold}>
              Profit if sold
            </th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.actual_recovery_vs_cost}>
              Recovery vs cost
            </th>
            <th className="px-3 py-3 text-right" title={MONEY_LANE_FORMULA_HELPERS.lost_profit}>
              Lost profit
            </th>
            <th className="px-3 py-3 text-left">Next action</th>
            <th className="px-3 py-3 text-right"> </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const family = row.family_key_v3 ?? row.claim_family;
            const tone = reimbursementTrackingStatusTone(row.reimbursement_tracking_status);
            const famTone = familyTone(family);
            const m = moneyLaneForSubmission(moneyLane, row.claim_submission_id);
            const mc = moneyCells(m);
            const reimbStatus = reimbursementMatchStatusFromPreview(m);

            return (
              <tr
                key={row.claim_submission_id}
                className={`${CLAIM_CENTER_TABLE_ROW_CLASS} ${familyRowClass(family)} ${
                  idx % 2 === 1 ? "bg-black/[0.015] dark:bg-white/[0.015]" : ""
                } ${selectedId === row.claim_submission_id ? "bg-sky-500/10" : ""}`}
                onClick={() => onSelect(row)}
              >
                <td className="px-3 py-2.5">
                  <span className={claimCenterBadgeTone(tone)}>
                    {reimbursementTrackingStatusLabel(row.reimbursement_tracking_status)}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className={claimCenterBadgeTone(famTone)}>{(family ?? "—").replace(/_/g, " ")}</span>
                </td>
                <td className="px-3 py-2.5 font-mono text-[10px]" title={row.claim_case_id}>
                  {shortId(row.claim_case_id)}
                </td>
                <td className="px-3 py-2.5 min-w-[140px]">
                  <IdentifierStack
                    asin={row.asin}
                    fnsku={row.fnsku}
                    sku={row.sku}
                    storePlatform={storePlatform}
                    compact
                    hideItemName
                  />
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{row.clean_quantity ?? "—"}</td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.sold} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.fees} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.settlement} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  {mc.cogs == null ? (
                    <span className="inline-flex flex-col items-end gap-1">
                      <MoneyCell value={mc.cogs} />
                      <MoneyLaneStatusBadge kind="needs_cogs" />
                    </span>
                  ) : (
                    <MoneyCell value={mc.cogs} />
                  )}
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.recovery} />
                </td>
                <td className="px-3 py-2.5">
                  <span className={claimCenterBadgeTone(reimbursementMatchStatusTone(reimbStatus))}>
                    {reimbursementMatchStatusLabel(reimbStatus)}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.reimb} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.gap} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.profitIfSold} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.recoveryVsCost} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={mc.lostProfit} />
                </td>
                <td className="px-3 py-2.5 max-w-[140px] text-xs">{deriveNextAction(row)}</td>
                <td className="px-3 py-2.5 text-right">
                  <ChevronRight className="inline h-4 w-4 opacity-50" aria-hidden />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
