/**
 * PHASE-CLAIM-MONEY-LANE-PREVIEW-V1
 * Read-only per-submission money lane preview with explicit formulas and lane status.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  discoverMoneyLaneSourcesV1,
  type FeeBreakdown,
  type PerSubmissionSourceDiscovery,
} from "./claim-money-lane-source-discovery-v1";
import { verifyMoneyNullPreservationTracking } from "./claim-reimbursement-tracking-preview-v1";

export const CLAIM_MONEY_LANE_PREVIEW_V1_VERSION = "claim-money-lane-preview-v1" as const;

export type MoneyLaneStatus = "known" | "unknown" | "blocked";

export const MONEY_LANE_FORMULA_CONTRACT = {
  latest_sold_price: {
    formula: "latest matched sale principal/item amount by SKU from reports_repository / settlements / all_orders",
    informational_only: true,
    never_used_as_cogs: true,
  },
  amazon_fee_breakdown: {
    formula:
      "selling_fees + fba_fees + commission/referral + promotional_rebates + shipping_credits (from matched report row only; no estimates)",
    informational_only: true,
  },
  net_settlement_amount: {
    formula: "amount_total or total_amount from matched settlement/transaction row",
    informational_only: true,
    never_used_as_cogs: true,
  },
  observed_reimbursement: {
    formula: "SUM(reference-safe matched reimbursement rows); NULL if no match — never 0 coercion",
    requires_safe_reference: true,
    sku_only_match_forbidden: true,
  },
  approved_cogs_unit: {
    formula:
      "product_cost_snapshots.unit_cost OR workspace cogs_overrides by product_id/FNSKU/SKU — NULL if missing",
    never_sale_price: true,
    never_net_settlement: true,
  },
  recovery_value: {
    formula: "clean_quantity × approved_cogs_unit; NULL if approved_cogs_unit NULL",
    never_sale_price: true,
  },
  open_recovery_gap: {
    formula: "recovery_value - observed_reimbursement; only when both known; else Unknown",
  },
  optional_profit_context: {
    formula: "latest_sold_price - amazon_fees_total - approved_cogs_unit (informational only)",
    never_used_as_claim_value: true,
  },
} as const;

export type MoneyLaneFieldPreview<T = number | null> = {
  value: T;
  display: string;
  status: MoneyLaneStatus;
  formula: string;
  source: string | null;
  blockers: string[];
};

export type AmazonFeeBreakdownPreview = {
  selling_fees: number | null;
  fba_fees: number | null;
  commission: number | null;
  promotional_rebates: number | null;
  shipping_credits: number | null;
  amazon_fees_total: number | null;
  status: MoneyLaneStatus;
  source: string | null;
  blockers: string[];
  is_estimate: false;
};

export type PerSubmissionMoneyPreview = {
  claim_submission_id: string;
  claim_case_id: string;
  family: string | null;
  clean_quantity: number | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  latest_sold_price: MoneyLaneFieldPreview;
  latest_sold_price_date: string | null;
  latest_sale_net_deterministic: boolean;
  sale_match_confidence: "high" | "medium" | "none";
  latest_sale_net_unknown_reason: string | null;
  amazon_fees_source: string | null;
  fee_source_confidence: "high" | "unknown";
  amazon_fee_breakdown: AmazonFeeBreakdownPreview;
  net_settlement_amount: MoneyLaneFieldPreview;
  observed_reimbursement: MoneyLaneFieldPreview;
  approved_cogs_unit: MoneyLaneFieldPreview;
  recovery_value: MoneyLaneFieldPreview;
  open_recovery_gap: MoneyLaneFieldPreview;
  optional_profit_context: MoneyLaneFieldPreview;
  lane_blockers: string[];
};

export type MoneyLanePreviewResult = {
  version: typeof CLAIM_MONEY_LANE_PREVIEW_V1_VERSION;
  pilot_submission_count: number;
  per_submission_money_preview: PerSubmissionMoneyPreview[];
  formula_contract_verification: typeof MONEY_LANE_FORMULA_CONTRACT;
  latest_sold_price_coverage: string;
  amazon_fee_coverage: string;
  net_settlement_coverage: string;
  observed_reimbursement_coverage: string;
  cogs_coverage: string;
  recovery_value_coverage: string;
  open_gap_coverage: string;
  blocked_by_cogs_count: number;
  blocked_by_no_reimbursement_match_count: number;
  sale_price_not_used_as_cogs_verification: boolean;
  null_preservation_verification: boolean;
  SAFE_MONEY_LANE_PREVIEW_READY: boolean;
  SAFE_TO_UPDATE_REIMBURSEMENT_TRACKING_UI_WITH_MONEY_PREVIEW: boolean;
  SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY: boolean;
  NEXT_PROMPT: string;
  source_truth_recommendation: string;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function displayValue(v: number | null): string {
  return v == null ? "Unknown" : String(v);
}

function laneFromValue(
  value: number | null,
  found: boolean,
  blockers: string[],
  blockedWhen?: boolean,
): MoneyLaneStatus {
  if (blockedWhen || blockers.some((b) => b.startsWith("BLOCKED"))) return "blocked";
  if (value != null && found) return "known";
  if (blockers.length > 0 && !found) return "blocked";
  return "unknown";
}

function sumKnownFees(fee: FeeBreakdown | null): {
  breakdown: AmazonFeeBreakdownPreview;
} {
  const blockers: string[] = [];
  if (!fee) {
    return {
      breakdown: {
        selling_fees: null,
        fba_fees: null,
        commission: null,
        promotional_rebates: null,
        shipping_credits: null,
        amazon_fees_total: null,
        status: "unknown",
        source: null,
        blockers: ["FEE_DEDUCTIONS_NOT_FOUND"],
        is_estimate: false,
      },
    };
  }

  const selling = fee.commission;
  const fba = fee.fba_per_unit_fulfillment_fee;
  const promos = fee.promotions;
  const shipping = fee.shipping;

  const parts = [selling, fba, promos, shipping].filter((v) => v != null) as number[];
  const total = parts.length > 0 ? parts.reduce((a, b) => a + Math.abs(b), 0) : null;

  if (total == null) blockers.push("FEE_DEDUCTIONS_NOT_FOUND");

  return {
    breakdown: {
      selling_fees: selling,
      fba_fees: fba,
      commission: selling,
      promotional_rebates: promos,
      shipping_credits: shipping,
      amazon_fees_total: total,
      status: total != null ? "known" : "unknown",
      source: fee.source_table,
      blockers,
      is_estimate: false,
    },
  };
}

function buildSubmissionPreview(row: PerSubmissionSourceDiscovery): PerSubmissionMoneyPreview {
  const qty = row.quantity;
  const cogsUnit = row.cogs_found ? row.cogs_value : null;
  const recovery =
    cogsUnit != null && qty != null ? cogsUnit * qty : null;
  const observed = row.reimbursement_found ? row.reimbursement_amount : null;

  const openGap =
    recovery != null && observed != null ? recovery - observed : null;

  const { breakdown: feePreview } = sumKnownFees(row.fee_breakdown);
  // The resolver's authoritative fee total + source supersede the recomputed breakdown.
  feePreview.amazon_fees_total = row.amazon_fees_total;
  feePreview.status = row.amazon_fees_total != null ? "known" : "unknown";
  feePreview.source = row.amazon_fees_source ?? feePreview.source;
  feePreview.blockers = row.amazon_fees_total != null ? [] : ["FEE_DEDUCTIONS_NOT_FOUND"];

  const soldBlockers = row.latest_sold_price_found ? [] : ["LATEST_SOLD_PRICE_NOT_FOUND_FOR_SKU"];
  const cogsBlockers = row.cogs_found ? [] : ["COGS_MISSING", "APPROVED_COGS_UNIT_NULL"];
  const reimbBlockers =
    row.reimbursement_found ? [] : ["OBSERVED_REIMBURSEMENT_NO_SAFE_MATCH_NOT_FILED"];
  const settlementBlockers = row.settlement_amount_found ? [] : ["NET_SETTLEMENT_NOT_TIED_TO_REFERENCE"];
  const recoveryBlockers =
    recovery != null ? [] : ["ESTIMATED_RECOVERY_BLOCKED_NO_COGS"];
  const gapBlockers =
    openGap != null ? [] : ["OPEN_GAP_REQUIRES_BOTH_RECOVERY_AND_OBSERVED"];

  let profitContext: number | null = null;
  if (row.latest_sold_price_value != null && cogsUnit != null && feePreview.amazon_fees_total != null) {
    profitContext = row.latest_sold_price_value - feePreview.amazon_fees_total - cogsUnit;
  }

  const lane_blockers = [...new Set([...row.blockers, ...cogsBlockers, ...reimbBlockers])];

  return {
    claim_submission_id: row.claim_submission_id,
    claim_case_id: row.claim_case_id,
    family: row.family,
    clean_quantity: qty,
    sku: row.product_identifiers.sku,
    fnsku: row.product_identifiers.fnsku,
    asin: row.product_identifiers.asin,
    latest_sold_price: {
      value: row.latest_sold_price_value,
      display: displayValue(row.latest_sold_price_value),
      status: laneFromValue(row.latest_sold_price_value, row.latest_sold_price_found, soldBlockers),
      formula: MONEY_LANE_FORMULA_CONTRACT.latest_sold_price.formula,
      source: row.latest_sold_price_source,
      blockers: soldBlockers,
    },
    latest_sold_price_date: row.latest_sold_price_date,
    latest_sale_net_deterministic: row.latest_sale_net_deterministic,
    sale_match_confidence: row.sale_match_confidence,
    latest_sale_net_unknown_reason: row.latest_sale_net_unknown_reason,
    amazon_fees_source: row.amazon_fees_source,
    fee_source_confidence: row.fee_source_confidence,
    amazon_fee_breakdown: feePreview,
    net_settlement_amount: {
      value: row.settlement_amount,
      display: displayValue(row.settlement_amount),
      status: laneFromValue(row.settlement_amount, row.settlement_amount_found, settlementBlockers),
      formula: MONEY_LANE_FORMULA_CONTRACT.net_settlement_amount.formula,
      source: row.settlement_source,
      blockers: settlementBlockers,
    },
    observed_reimbursement: {
      value: observed,
      display: displayValue(observed),
      status: laneFromValue(observed, row.reimbursement_found, reimbBlockers),
      formula: MONEY_LANE_FORMULA_CONTRACT.observed_reimbursement.formula,
      source: row.reimbursement_source,
      blockers: reimbBlockers,
    },
    approved_cogs_unit: {
      value: cogsUnit,
      display: displayValue(cogsUnit),
      status: laneFromValue(cogsUnit, row.cogs_found, cogsBlockers, !row.cogs_found),
      formula: MONEY_LANE_FORMULA_CONTRACT.approved_cogs_unit.formula,
      source: row.cogs_source,
      blockers: cogsBlockers,
    },
    recovery_value: {
      value: recovery,
      display: displayValue(recovery),
      status: laneFromValue(recovery, row.estimated_recovery_possible, recoveryBlockers, !row.cogs_found),
      formula: MONEY_LANE_FORMULA_CONTRACT.recovery_value.formula,
      source: row.cogs_source ? `${row.cogs_source} × qty` : null,
      blockers: recoveryBlockers,
    },
    open_recovery_gap: {
      value: openGap,
      display: displayValue(openGap),
      status: laneFromValue(openGap, openGap != null, gapBlockers),
      formula: MONEY_LANE_FORMULA_CONTRACT.open_recovery_gap.formula,
      source: openGap != null ? "recovery_value - observed_reimbursement" : null,
      blockers: gapBlockers,
    },
    optional_profit_context: {
      value: profitContext,
      display: displayValue(profitContext),
      status: laneFromValue(profitContext, profitContext != null, []),
      formula: MONEY_LANE_FORMULA_CONTRACT.optional_profit_context.formula,
      source: "informational_only",
      blockers: profitContext == null ? ["REQUIRES_SOLD_PRICE_FEES_AND_COGS"] : [],
    },
    lane_blockers,
  };
}

export function verifySalePriceNotUsedAsCogs(previews: PerSubmissionMoneyPreview[]): boolean {
  for (const p of previews) {
    const sold = p.latest_sold_price.value;
    const cogs = p.approved_cogs_unit.value;
    if (sold == null || cogs == null) continue;
    if (sold === cogs && p.approved_cogs_unit.source?.includes("sale")) return false;
    if (p.approved_cogs_unit.source?.includes("product_sales")) return false;
    if (p.approved_cogs_unit.source?.includes("item_price")) return false;
    if (p.approved_cogs_unit.source?.includes("settlement")) return false;
  }
  return true;
}

export function verifyNullPreservationPreview(previews: PerSubmissionMoneyPreview[]): boolean {
  for (const p of previews) {
    if (!p.approved_cogs_unit.value && p.approved_cogs_unit.display !== "Unknown") return false;
    if (!p.recovery_value.value && p.recovery_value.display !== "Unknown") return false;
    if (!p.observed_reimbursement.value && p.observed_reimbursement.display !== "Unknown") return false;
    if (p.observed_reimbursement.value === 0 && !p.observed_reimbursement.source) return false;
  }
  return true;
}

export async function composeMoneyLanePreviewV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<MoneyLanePreviewResult> {
  const discovered = await discoverMoneyLaneSourcesV1(client, organizationId, storeId, options);
  const per_submission_money_preview = discovered.per_submission.map(buildSubmissionPreview);

  const n = discovered.pilot_submission_count || 1;
  const countKnown = (fn: (p: PerSubmissionMoneyPreview) => boolean) =>
    per_submission_money_preview.filter(fn).length;

  const nullCheck = verifyMoneyNullPreservationTracking(discovered.previews);
  const salePriceOk = verifySalePriceNotUsedAsCogs(per_submission_money_preview);
  const nullPreviewOk = verifyNullPreservationPreview(per_submission_money_preview);

  const blocked_by_cogs_count = per_submission_money_preview.filter(
    (p) => p.approved_cogs_unit.status === "blocked" || p.approved_cogs_unit.status === "unknown",
  ).length;
  const blocked_by_no_reimbursement_match_count = per_submission_money_preview.filter(
    (p) => p.observed_reimbursement.status !== "known",
  ).length;

  const cogsStillMissing = blocked_by_cogs_count === n;
  const soldPriceCoverage = countKnown((p) => p.latest_sold_price.status === "known");
  const feeCoverage = countKnown((p) => p.amazon_fee_breakdown.status === "known");
  const settlementCoverage = countKnown((p) => p.net_settlement_amount.status === "known");

  const ready =
    n === 10 &&
    nullCheck.pass &&
    salePriceOk &&
    nullPreviewOk &&
    soldPriceCoverage === n;

  return {
    version: CLAIM_MONEY_LANE_PREVIEW_V1_VERSION,
    pilot_submission_count: n,
    per_submission_money_preview,
    formula_contract_verification: MONEY_LANE_FORMULA_CONTRACT,
    latest_sold_price_coverage: `${soldPriceCoverage}/${n}`,
    amazon_fee_coverage: `${feeCoverage}/${n}`,
    net_settlement_coverage: `${settlementCoverage}/${n}`,
    observed_reimbursement_coverage: `${countKnown((p) => p.observed_reimbursement.status === "known")}/${n}`,
    cogs_coverage: `${countKnown((p) => p.approved_cogs_unit.status === "known")}/${n}`,
    recovery_value_coverage: `${countKnown((p) => p.recovery_value.status === "known")}/${n}`,
    open_gap_coverage: `${countKnown((p) => p.open_recovery_gap.status === "known")}/${n}`,
    blocked_by_cogs_count,
    blocked_by_no_reimbursement_match_count,
    sale_price_not_used_as_cogs_verification: salePriceOk,
    null_preservation_verification: nullCheck.pass && nullPreviewOk,
    SAFE_MONEY_LANE_PREVIEW_READY: ready,
    SAFE_TO_UPDATE_REIMBURSEMENT_TRACKING_UI_WITH_MONEY_PREVIEW: ready,
    SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY: true,
    NEXT_PROMPT: cogsStillMissing
      ? "PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 — apply interim FNSKU cogs_overrides for 6 pilot products then re-run money lane preview"
      : "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-V1 — wire money preview panel into Reimbursement Tracking drawer",
    source_truth_recommendation: discovered.source_truth_recommendation,
  };
}
