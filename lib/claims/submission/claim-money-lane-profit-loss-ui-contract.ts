/**
 * PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-V1
 * PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-AFTER-COGS-V1
 * UI contract for money lane / profit-loss display in Reimbursement Tracking.
 */
import type {
  FeeLabel,
  MoneyViewField,
  PerSubmissionMoneyPreviewV2,
} from "./claim-money-lane-preview-v2-profit-loss-v1";
import { MONEY_LANE_FORMULA_CONTRACT_V2 } from "./claim-money-lane-preview-v2-profit-loss-v1";

export const MONEY_LANE_PROFIT_LOSS_UI_VERSION = "claim-money-lane-profit-loss-ui-v1" as const;
export const MONEY_LANE_PROFIT_LOSS_UI_AFTER_COGS_VERSION =
  "claim-money-lane-profit-loss-ui-after-cogs-v1" as const;

export const MONEY_LANE_UI_TOOLTIPS = {
  sale_price:
    "Sale price is used for estimate only. It is never used as COGS or recoverable claim value.",
  cogs: "COGS is required for recovery value. Enter approved unit cost before claiming recovery.",
  amazon_fees:
    "Amazon fees come from settlement/transaction reports when available. Category-rate estimates are labeled separately.",
  reimbursement:
    "Observed reimbursement requires a reference-safe match. No match shows Unknown — not $0.",
  null_preservation: "Unknown values are not treated as zero.",
} as const;

export const MONEY_LANE_FORMULA_HELPERS = {
  sale_gross: MONEY_LANE_FORMULA_CONTRACT_V2.gross_sale_value.formula,
  amazon_fees:
    "amazon_fees_total = selling_fees + fba_fees + commission/referral_fee + promotional_rebates + shipping_credits/chargebacks",
  net_settlement: MONEY_LANE_FORMULA_CONTRACT_V2.net_settlement_amount.formula,
  recovery: MONEY_LANE_FORMULA_CONTRACT_V2.recovery_value.formula,
  observed_reimb: MONEY_LANE_FORMULA_CONTRACT_V2.observed_reimbursement.formula,
  open_gap: MONEY_LANE_FORMULA_CONTRACT_V2.open_recovery_gap.formula,
  profit_if_sold:
    "profit_if_sold = (latest_sold_price - amazon_fees_per_unit - approved_cogs_unit) × clean_quantity",
  actual_recovery_vs_cost: MONEY_LANE_FORMULA_CONTRACT_V2.actual_recovery_vs_cost.formula,
  lost_profit: MONEY_LANE_FORMULA_CONTRACT_V2.lost_profit_estimate.formula,
} as const;

export type ProfitLossSummaryCards = {
  total_gross_sale_estimate: number | null;
  total_amazon_fees: number | null;
  total_net_settlement: number | null;
  cogs_coverage: string;
  cogs_known_count: number;
  recovery_known_count: number;
  recovery_unknown_count: number;
  total_recovery_value: number | null;
  reimbursement_matched_count: number;
  reimbursement_unknown_count: number;
  total_observed_reimbursement: number | null;
  total_open_recovery_gap: number | null;
  total_lost_profit_estimate: number | null;
  lost_profit_complete_count: number;
};

export type ReimbursementMatchUiStatus = "matched" | "unknown";

export type MoneyLaneUiBundle = {
  version:
    | typeof MONEY_LANE_PROFIT_LOSS_UI_VERSION
    | typeof MONEY_LANE_PROFIT_LOSS_UI_AFTER_COGS_VERSION;
  preview_run_reference: string;
  coverage: {
    sale_view: string;
    fee_view: string;
    settlement_view: string;
    cogs: string;
    recovery_value: string;
    reimbursement: string;
    profit_loss_complete: string;
  };
  summary_cards: ProfitLossSummaryCards;
  by_submission_id: Record<string, PerSubmissionMoneyPreviewV2>;
};

function sumKnown(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

export function buildProfitLossSummaryCards(
  previews: PerSubmissionMoneyPreviewV2[],
): ProfitLossSummaryCards {
  const n = previews.length;
  const cogsKnown = previews.filter(
    (p) => p.cost_recovery_view.approved_cogs_unit.status === "known",
  ).length;
  const recoveryKnown = previews.filter(
    (p) => p.cost_recovery_view.recovery_value.status === "known",
  ).length;
  const reimbMatched = previews.filter(
    (p) => p.reimbursement_view.observed_reimbursement.status === "known",
  ).length;

  return {
    total_gross_sale_estimate: sumKnown(
      previews.map((p) => p.sale_view.gross_sale_value.value),
    ),
    total_amazon_fees: sumKnown(
      previews.map((p) => p.amazon_fee_view.estimated_amazon_fees.value),
    ),
    total_net_settlement: sumKnown(
      previews.map((p) => p.settlement_view.net_settlement_amount.value),
    ),
    cogs_coverage: `${cogsKnown}/${n}`,
    cogs_known_count: cogsKnown,
    recovery_known_count: recoveryKnown,
    recovery_unknown_count: n - recoveryKnown,
    total_recovery_value: sumKnown(
      previews.map((p) => p.cost_recovery_view.recovery_value.value),
    ),
    reimbursement_matched_count: reimbMatched,
    reimbursement_unknown_count: n - reimbMatched,
    total_observed_reimbursement: sumKnown(
      previews.map((p) => p.reimbursement_view.observed_reimbursement.value),
    ),
    total_open_recovery_gap: sumKnown(
      previews.map((p) => p.open_gap_view.open_recovery_gap.value),
    ),
    total_lost_profit_estimate: sumKnown(
      previews.map((p) => p.profit_loss_view.lost_profit_estimate.value),
    ),
    lost_profit_complete_count: previews.filter(
      (p) => p.profit_loss_view.analysis_status === "complete",
    ).length,
  };
}

export function buildMoneyLaneUiBundle(args: {
  per_submission: PerSubmissionMoneyPreviewV2[];
  preview_run_reference: string;
  coverage: MoneyLaneUiBundle["coverage"];
  version?: MoneyLaneUiBundle["version"];
}): MoneyLaneUiBundle {
  const by_submission_id: Record<string, PerSubmissionMoneyPreviewV2> = {};
  for (const row of args.per_submission) {
    by_submission_id[row.claim_submission_id] = row;
  }
  return {
    version: args.version ?? MONEY_LANE_PROFIT_LOSS_UI_AFTER_COGS_VERSION,
    preview_run_reference: args.preview_run_reference,
    coverage: args.coverage,
    summary_cards: buildProfitLossSummaryCards(args.per_submission),
    by_submission_id,
  };
}

export function moneyLaneForSubmission(
  bundle: MoneyLaneUiBundle | null | undefined,
  submissionId: string,
): PerSubmissionMoneyPreviewV2 | null {
  return bundle?.by_submission_id[submissionId] ?? null;
}

export function feeLabelBadgeTone(label: FeeLabel): string {
  switch (label) {
    case "actual":
      return "success";
    case "estimate":
      return "info";
    default:
      return "neutral";
  }
}

export function feeLabelDisplay(label: FeeLabel): string {
  switch (label) {
    case "actual":
      return "Actual";
    case "estimate":
      return "Estimate";
    default:
      return "Unknown";
  }
}

export function moneyFieldLabel(field: MoneyViewField): FeeLabel {
  return field.label;
}

export function reimbursementMatchStatusFromPreview(
  preview: PerSubmissionMoneyPreviewV2 | null,
): ReimbursementMatchUiStatus {
  if (!preview) return "unknown";
  return preview.reimbursement_view.observed_reimbursement.status === "known"
    ? "matched"
    : "unknown";
}

export function reimbursementMatchStatusLabel(status: ReimbursementMatchUiStatus): string {
  return status === "matched" ? "Matched" : "Not filed / no safe match";
}

export function reimbursementMatchStatusTone(status: ReimbursementMatchUiStatus): string {
  return status === "matched" ? "success" : "neutral";
}

export function parseCogsCoverageRatio(coverage: string): { known: number; total: number } | null {
  const match = /^(\d+)\/(\d+)$/.exec(coverage.trim());
  if (!match) return null;
  return { known: Number(match[1]), total: Number(match[2]) };
}

export function profitIfSoldFromPreview(p: PerSubmissionMoneyPreviewV2): number | null {
  const sold = p.sale_view.latest_sold_price.value;
  const feeUnit = p.amazon_fee_view.amazon_fees_per_unit.value;
  const cogs = p.cost_recovery_view.approved_cogs_unit.value;
  const qty = p.clean_quantity;
  if (sold == null || feeUnit == null || cogs == null || qty == null) return null;
  return (sold - feeUnit - cogs) * qty;
}

export function verifySalePriceNotUsedAsCogsUi(
  previews: PerSubmissionMoneyPreviewV2[],
): boolean {
  for (const p of previews) {
    const sold = p.sale_view.latest_sold_price.value;
    const cogs = p.cost_recovery_view.approved_cogs_unit.value;
    const src = p.cost_recovery_view.approved_cogs_unit.source ?? "";
    if (sold == null || cogs == null) continue;
    if (sold === cogs && src.toLowerCase().includes("sale")) return false;
    if (/product_sales|item_price|settlement/.test(src)) return false;
  }
  return true;
}

export function verifyUnknownNotCoerced(previews: PerSubmissionMoneyPreviewV2[]): boolean {
  for (const p of previews) {
    const checks: MoneyViewField[] = [
      p.cost_recovery_view.approved_cogs_unit,
      p.cost_recovery_view.recovery_value,
      p.reimbursement_view.observed_reimbursement,
      p.open_gap_view.open_recovery_gap,
      p.profit_loss_view.lost_profit_estimate,
    ];
    for (const f of checks) {
      if (f.value == null && f.display !== "Unknown") return false;
    }
  }
  return true;
}

export function verifyActualVsEstimateLabels(previews: PerSubmissionMoneyPreviewV2[]): boolean {
  for (const p of previews) {
    const b = p.amazon_fee_view.breakdown;
    if (b.fee_label === "actual" && b.is_estimate) return false;
    if (b.fee_label === "estimate" && !b.is_estimate && b.amazon_fees_total != null) return false;
  }
  return true;
}
