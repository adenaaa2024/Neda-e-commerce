/**
 * PHASE-CLAIM-MONEY-LANE-PREVIEW-V2-PROFIT-LOSS-ANALYSIS
 * Read-only per-submission money lane + profit/loss views with explicit formulas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { buildFeeAdjustedEstimate } from "@/lib/fees/fee-adjusted-estimate-readmodel";
import {
  discoverMoneyLaneSourcesV1,
  type FeeBreakdown,
  type PerSubmissionSourceDiscovery,
} from "./claim-money-lane-source-discovery-v1";
import {
  MONEY_LANE_FORMULA_CONTRACT,
  type MoneyLaneStatus,
} from "./claim-money-lane-preview-v1";
import { verifyMoneyNullPreservationTracking } from "./claim-reimbursement-tracking-preview-v1";

export const CLAIM_MONEY_LANE_PREVIEW_V2_VERSION =
  "claim-money-lane-preview-v2-profit-loss-v1" as const;

export const MONEY_LANE_FORMULA_CONTRACT_V2 = {
  ...MONEY_LANE_FORMULA_CONTRACT,
  gross_sale_value: {
    formula: "clean_quantity × latest_sold_price",
    informational_only: true,
    never_used_as_cogs: true,
  },
  amazon_fees_per_unit: {
    formula:
      "amazon_fees_total from matched report row when line is per-unit; else NULL until line total used",
    label_when_actual: "actual",
    label_when_estimate: "estimate",
  },
  estimated_amazon_fees: {
    formula:
      "clean_quantity × amazon_fees_per_unit when per-unit valid; otherwise matched line amazon_fees_total",
    never_mix_actual_and_estimate: true,
  },
  estimated_net_sale: {
    formula: "gross_sale_value - estimated_amazon_fees",
    informational_only: true,
  },
  estimated_profit_if_sold: {
    formula: "estimated_net_sale - (clean_quantity × approved_cogs_unit)",
    requires_approved_cogs: true,
    never_use_sale_price_as_cogs: true,
  },
  actual_recovery_vs_cost: {
    formula: "observed_reimbursement - (clean_quantity × approved_cogs_unit)",
    requires_both_reimbursement_and_cogs: true,
  },
  lost_profit_estimate: {
    formula:
      "estimated_profit_if_sold - max(actual_recovery_vs_cost, 0); only when all inputs known",
    requires_complete_inputs: true,
    blocked_when_cogs_missing: true,
  },
  informational_sale_estimate: {
    formula: "gross_sale_value and estimated_net_sale shown without final loss claim when COGS missing",
    note: "Does not claim final loss — sale-based estimate only",
  },
} as const;

export type FeeLabel = "actual" | "estimate" | "unknown";

export type MoneyViewField = {
  value: number | null;
  display: string;
  status: MoneyLaneStatus;
  formula: string;
  source: string | null;
  label: FeeLabel;
  blockers: string[];
};

export type AmazonFeeBreakdownV2 = {
  selling_fees: number | null;
  fba_fees: number | null;
  commission: number | null;
  promotional_rebates: number | null;
  shipping_credits: number | null;
  amazon_fees_total: number | null;
  status: MoneyLaneStatus;
  source: string | null;
  fee_label: FeeLabel;
  is_estimate: boolean;
  blockers: string[];
};

export type SaleView = {
  latest_sold_price: MoneyViewField;
  gross_sale_value: MoneyViewField;
  view_note: "informational_only — not claim recovery basis";
};

export type AmazonFeeView = {
  breakdown: AmazonFeeBreakdownV2;
  amazon_fees_per_unit: MoneyViewField;
  estimated_amazon_fees: MoneyViewField;
};

export type SettlementView = {
  net_settlement_amount: MoneyViewField;
};

export type CostRecoveryView = {
  approved_cogs_unit: MoneyViewField;
  recovery_value: MoneyViewField;
};

export type ReimbursementView = {
  observed_reimbursement: MoneyViewField;
};

export type OpenGapView = {
  open_recovery_gap: MoneyViewField;
};

export type ProfitLossView = {
  estimated_net_sale: MoneyViewField;
  estimated_profit_if_sold: MoneyViewField;
  actual_recovery_vs_cost: MoneyViewField;
  lost_profit_estimate: MoneyViewField;
  informational_sale_estimate: MoneyViewField | null;
  analysis_status: "complete" | "informational_only" | "blocked";
  analysis_note: string;
};

export type PerSubmissionMoneyPreviewV2 = {
  claim_submission_id: string;
  claim_case_id: string;
  family: string | null;
  clean_quantity: number | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  sale_view: SaleView;
  amazon_fee_view: AmazonFeeView;
  settlement_view: SettlementView;
  cost_recovery_view: CostRecoveryView;
  reimbursement_view: ReimbursementView;
  open_gap_view: OpenGapView;
  profit_loss_view: ProfitLossView;
  unknown_fields: string[];
  lane_blockers: string[];
};

export type MoneyLanePreviewV2Result = {
  version: typeof CLAIM_MONEY_LANE_PREVIEW_V2_VERSION;
  pilot_submission_count: number;
  formula_contract: typeof MONEY_LANE_FORMULA_CONTRACT_V2;
  per_submission_money_preview_v2: PerSubmissionMoneyPreviewV2[];
  sale_view_coverage: string;
  fee_view_coverage: string;
  settlement_view_coverage: string;
  cogs_coverage: string;
  recovery_value_coverage: string;
  reimbursement_coverage: string;
  open_gap_coverage: string;
  profit_loss_coverage: string;
  unknown_fields_by_submission: Record<string, string[]>;
  blockers: string[];
  actual_vs_estimated_fee_label_verification: boolean;
  sale_price_not_used_as_cogs_verification: boolean;
  null_preservation_verification: boolean;
  SAFE_MONEY_LANE_PROFIT_LOSS_PREVIEW_READY: boolean;
  SAFE_TO_UPDATE_REIMBURSEMENT_TRACKING_UI_WITH_PROFIT_LOSS: boolean;
  SAFE_TO_PLAN_COGS_APPLY_EXECUTE: boolean;
  SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY: boolean;
  NEXT_PROMPT: string;
};

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

function field(
  value: number | null,
  found: boolean,
  blockers: string[],
  formula: string,
  source: string | null,
  label: FeeLabel,
  blockedWhen?: boolean,
): MoneyViewField {
  return {
    value,
    display: displayValue(value),
    status: laneFromValue(value, found, blockers, blockedWhen),
    formula,
    source,
    label,
    blockers,
  };
}

function sumKnownFeesActual(fee: FeeBreakdown | null): AmazonFeeBreakdownV2 {
  if (!fee) {
    return {
      selling_fees: null,
      fba_fees: null,
      commission: null,
      promotional_rebates: null,
      shipping_credits: null,
      amazon_fees_total: null,
      status: "unknown",
      source: null,
      fee_label: "unknown",
      is_estimate: false,
      blockers: ["FEE_DEDUCTIONS_NOT_FOUND"],
    };
  }

  const selling = fee.commission;
  const fba = fee.fba_per_unit_fulfillment_fee;
  const promos = fee.promotions;
  const shipping = fee.shipping;
  const parts = [selling, fba, promos, shipping].filter((v) => v != null) as number[];
  const total = parts.length > 0 ? parts.reduce((a, b) => a + Math.abs(b), 0) : null;

  return {
    selling_fees: selling,
    fba_fees: fba,
    commission: selling,
    promotional_rebates: promos,
    shipping_credits: shipping,
    amazon_fees_total: total,
    status: total != null ? "known" : "unknown",
    source: fee.source_table,
    fee_label: total != null ? "actual" : "unknown",
    is_estimate: false,
    blockers: total == null ? ["FEE_DEDUCTIONS_NOT_FOUND"] : [],
  };
}

function feeBreakdownFromEstimate(args: {
  estimated_total: number | null;
  source: string;
  components: Record<string, number | null>;
}): AmazonFeeBreakdownV2 {
  return {
    selling_fees: args.components.referral ?? null,
    fba_fees: args.components.fba ?? null,
    commission: args.components.referral ?? null,
    promotional_rebates: null,
    shipping_credits: null,
    amazon_fees_total: args.estimated_total,
    status: args.estimated_total != null ? "known" : "unknown",
    source: args.source,
    fee_label: args.estimated_total != null ? "estimate" : "unknown",
    is_estimate: true,
    blockers: args.estimated_total == null ? ["FEE_ESTIMATE_UNAVAILABLE"] : [],
  };
}

function perUnitFeesValid(
  soldPrice: number | null,
  feesTotal: number | null,
  qty: number | null,
): boolean {
  if (soldPrice == null || feesTotal == null) return false;
  if (qty == null || qty <= 0) return false;
  return true;
}

function collectUnknownFields(p: PerSubmissionMoneyPreviewV2): string[] {
  const unknown: string[] = [];
  const check = (name: string, f: MoneyViewField) => {
    if (f.status !== "known") unknown.push(name);
  };
  check("latest_sold_price", p.sale_view.latest_sold_price);
  check("gross_sale_value", p.sale_view.gross_sale_value);
  check("amazon_fees", p.amazon_fee_view.estimated_amazon_fees);
  check("net_settlement", p.settlement_view.net_settlement_amount);
  check("approved_cogs_unit", p.cost_recovery_view.approved_cogs_unit);
  check("recovery_value", p.cost_recovery_view.recovery_value);
  check("observed_reimbursement", p.reimbursement_view.observed_reimbursement);
  check("open_recovery_gap", p.open_gap_view.open_recovery_gap);
  if (p.profit_loss_view.analysis_status === "complete") {
    check("lost_profit_estimate", p.profit_loss_view.lost_profit_estimate);
  }
  return unknown;
}

function verifyFeeLabelNoMix(previews: PerSubmissionMoneyPreviewV2[]): boolean {
  for (const p of previews) {
    const b = p.amazon_fee_view.breakdown;
    if (b.fee_label === "actual" && b.is_estimate) return false;
    if (b.fee_label === "estimate" && !b.is_estimate && b.amazon_fees_total != null) return false;
    if (b.fee_label === "actual" && b.source?.includes("category_rate")) return false;
    if (b.fee_label === "estimate" && b.source?.includes("reports_repository") && !b.is_estimate)
      return false;
  }
  return true;
}

function verifyNullPreservationV2(previews: PerSubmissionMoneyPreviewV2[]): boolean {
  for (const p of previews) {
    const fields = [
      p.cost_recovery_view.approved_cogs_unit,
      p.cost_recovery_view.recovery_value,
      p.reimbursement_view.observed_reimbursement,
      p.open_gap_view.open_recovery_gap,
      p.profit_loss_view.lost_profit_estimate,
    ];
    for (const f of fields) {
      if (f.value == null && f.display !== "Unknown") return false;
    }
    if (
      p.reimbursement_view.observed_reimbursement.value === 0 &&
      !p.reimbursement_view.observed_reimbursement.source
    ) {
      return false;
    }
  }
  return true;
}

function verifySalePriceNotUsedAsCogsV2(previews: PerSubmissionMoneyPreviewV2[]): boolean {
  for (const p of previews) {
    const sold = p.sale_view.latest_sold_price.value;
    const cogs = p.cost_recovery_view.approved_cogs_unit.value;
    const src = p.cost_recovery_view.approved_cogs_unit.source ?? "";
    if (sold == null || cogs == null) continue;
    if (sold === cogs && src.includes("sale")) return false;
    if (src.includes("product_sales") || src.includes("item_price") || src.includes("settlement"))
      return false;
  }
  return true;
}

async function buildSubmissionPreviewV2(
  row: PerSubmissionSourceDiscovery,
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<PerSubmissionMoneyPreviewV2> {
  const qty = row.quantity;
  const soldUnit = row.latest_sold_price_value;
  const cogsUnit = row.cogs_found ? row.cogs_value : null;
  const observed = row.reimbursement_found ? row.reimbursement_amount : null;

  let feeBreakdown = sumKnownFeesActual(row.fee_breakdown);

  if (feeBreakdown.amazon_fees_total == null && row.product_identifiers.resolved_product_id) {
    try {
      const estimate = await buildFeeAdjustedEstimate(
        client,
        organizationId,
        storeId,
        row.product_identifiers.resolved_product_id,
      );
      if (estimate.estimated_total_amazon_fees != null) {
        feeBreakdown = feeBreakdownFromEstimate({
          estimated_total: estimate.estimated_total_amazon_fees,
          source: "fee-adjusted-estimate-readmodel.category_rate",
          components: {
            referral: estimate.estimated_referral_fee,
            fba: estimate.estimated_fba_fulfillment_fee,
          },
        });
      }
    } catch {
      // read-only — fee estimate optional
    }
  }

  const feesPerUnit =
    feeBreakdown.amazon_fees_total != null && soldUnit != null
      ? feeBreakdown.amazon_fees_total
      : null;
  const perUnitValid = perUnitFeesValid(soldUnit, feesPerUnit, qty);
  const estimatedAmazonFees =
    perUnitValid && qty != null && feesPerUnit != null
      ? qty * feesPerUnit
      : feeBreakdown.amazon_fees_total;

  const grossSale = soldUnit != null && qty != null ? soldUnit * qty : null;
  const recovery = cogsUnit != null && qty != null ? cogsUnit * qty : null;
  const openGap = recovery != null && observed != null ? recovery - observed : null;

  const soldBlockers = row.latest_sold_price_found ? [] : ["LATEST_SOLD_PRICE_NOT_FOUND_FOR_SKU"];
  const cogsBlockers = row.cogs_found ? [] : ["COGS_MISSING", "APPROVED_COGS_UNIT_NULL"];
  const reimbBlockers =
    row.reimbursement_found ? [] : ["OBSERVED_REIMBURSEMENT_NO_SAFE_MATCH_NOT_FILED"];
  const settlementBlockers = row.settlement_amount_found ? [] : ["NET_SETTLEMENT_NOT_TIED_TO_REFERENCE"];
  const feeBlockers = feeBreakdown.amazon_fees_total != null ? [] : ["FEE_DEDUCTIONS_NOT_FOUND"];
  const recoveryBlockers = recovery != null ? [] : ["ESTIMATED_RECOVERY_BLOCKED_NO_COGS"];
  const gapBlockers = openGap != null ? [] : ["OPEN_GAP_REQUIRES_BOTH_RECOVERY_AND_OBSERVED"];

  const estimatedNetSale =
    grossSale != null && estimatedAmazonFees != null ? grossSale - estimatedAmazonFees : null;
  const estimatedProfitIfSold =
    estimatedNetSale != null && cogsUnit != null && qty != null
      ? estimatedNetSale - cogsUnit * qty
      : null;
  const actualRecoveryVsCost =
    observed != null && cogsUnit != null && qty != null ? observed - cogsUnit * qty : null;

  let lostProfit: number | null = null;
  let analysisStatus: ProfitLossView["analysis_status"] = "blocked";
  let analysisNote = "Profit/loss analysis blocked — missing required inputs.";

  if (cogsUnit == null) {
    analysisStatus = "informational_only";
    analysisNote =
      "COGS missing — sale-based gross_sale_value and estimated_net_sale are informational only; no final loss claim.";
  } else if (
    estimatedProfitIfSold != null &&
    actualRecoveryVsCost != null &&
    grossSale != null &&
    estimatedAmazonFees != null
  ) {
    lostProfit = estimatedProfitIfSold - Math.max(actualRecoveryVsCost, 0);
    analysisStatus = "complete";
    analysisNote = "All profit/loss inputs known — lost_profit_estimate computed.";
  } else if (estimatedNetSale != null) {
    analysisStatus = "informational_only";
    analysisNote =
      "Partial inputs — estimated_net_sale available; reimbursement or COGS gap prevents final loss estimate.";
  }

  const informationalSaleEstimate =
    cogsUnit == null && grossSale != null
      ? field(
          estimatedNetSale,
          estimatedNetSale != null,
          estimatedNetSale == null ? ["REQUIRES_GROSS_AND_FEES"] : [],
          MONEY_LANE_FORMULA_CONTRACT_V2.informational_sale_estimate.formula,
          "informational_sale_estimate",
          "unknown",
        )
      : null;

  const lane_blockers = [...new Set([...row.blockers, ...cogsBlockers, ...reimbBlockers])];

  const preview: PerSubmissionMoneyPreviewV2 = {
    claim_submission_id: row.claim_submission_id,
    claim_case_id: row.claim_case_id,
    family: row.family,
    clean_quantity: qty,
    sku: row.product_identifiers.sku,
    fnsku: row.product_identifiers.fnsku,
    asin: row.product_identifiers.asin,
    sale_view: {
      latest_sold_price: field(
        soldUnit,
        row.latest_sold_price_found,
        soldBlockers,
        MONEY_LANE_FORMULA_CONTRACT_V2.latest_sold_price.formula,
        row.latest_sold_price_source,
        "actual",
      ),
      gross_sale_value: field(
        grossSale,
        grossSale != null,
        grossSale == null ? ["REQUIRES_SOLD_PRICE_AND_QTY"] : [],
        MONEY_LANE_FORMULA_CONTRACT_V2.gross_sale_value.formula,
        grossSale != null ? "clean_quantity × latest_sold_price" : null,
        "actual",
      ),
      view_note: "informational_only — not claim recovery basis",
    },
    amazon_fee_view: {
      breakdown: feeBreakdown,
      amazon_fees_per_unit: field(
        feesPerUnit,
        feesPerUnit != null,
        feeBlockers,
        MONEY_LANE_FORMULA_CONTRACT_V2.amazon_fees_per_unit.formula,
        feeBreakdown.source,
        feeBreakdown.fee_label,
      ),
      estimated_amazon_fees: field(
        estimatedAmazonFees,
        estimatedAmazonFees != null,
        feeBlockers,
        MONEY_LANE_FORMULA_CONTRACT_V2.estimated_amazon_fees.formula,
        perUnitValid ? "qty × per_unit" : feeBreakdown.source,
        feeBreakdown.fee_label,
      ),
    },
    settlement_view: {
      net_settlement_amount: field(
        row.settlement_amount,
        row.settlement_amount_found,
        settlementBlockers,
        MONEY_LANE_FORMULA_CONTRACT_V2.net_settlement_amount.formula,
        row.settlement_source,
        "actual",
      ),
    },
    cost_recovery_view: {
      approved_cogs_unit: field(
        cogsUnit,
        row.cogs_found,
        cogsBlockers,
        MONEY_LANE_FORMULA_CONTRACT_V2.approved_cogs_unit.formula,
        row.cogs_source,
        row.cogs_found ? "actual" : "unknown",
        !row.cogs_found,
      ),
      recovery_value: field(
        recovery,
        row.estimated_recovery_possible,
        recoveryBlockers,
        MONEY_LANE_FORMULA_CONTRACT_V2.recovery_value.formula,
        row.cogs_source ? `${row.cogs_source} × qty` : null,
        row.cogs_found ? "actual" : "unknown",
        !row.cogs_found,
      ),
    },
    reimbursement_view: {
      observed_reimbursement: field(
        observed,
        row.reimbursement_found,
        reimbBlockers,
        MONEY_LANE_FORMULA_CONTRACT_V2.observed_reimbursement.formula,
        row.reimbursement_source,
        row.reimbursement_found ? "actual" : "unknown",
      ),
    },
    open_gap_view: {
      open_recovery_gap: field(
        openGap,
        openGap != null,
        gapBlockers,
        MONEY_LANE_FORMULA_CONTRACT_V2.open_recovery_gap.formula,
        openGap != null ? "recovery_value - observed_reimbursement" : null,
        openGap != null ? "actual" : "unknown",
      ),
    },
    profit_loss_view: {
      estimated_net_sale: field(
        estimatedNetSale,
        estimatedNetSale != null,
        estimatedNetSale == null ? ["REQUIRES_GROSS_AND_FEES"] : [],
        MONEY_LANE_FORMULA_CONTRACT_V2.estimated_net_sale.formula,
        "gross_sale_value - estimated_amazon_fees",
        "actual",
      ),
      estimated_profit_if_sold: field(
        estimatedProfitIfSold,
        estimatedProfitIfSold != null,
        estimatedProfitIfSold == null ? ["REQUIRES_COGS_AND_NET_SALE"] : [],
        MONEY_LANE_FORMULA_CONTRACT_V2.estimated_profit_if_sold.formula,
        cogsUnit != null ? "estimated_net_sale - (qty × cogs)" : null,
        cogsUnit != null ? "actual" : "unknown",
        cogsUnit == null,
      ),
      actual_recovery_vs_cost: field(
        actualRecoveryVsCost,
        actualRecoveryVsCost != null,
        actualRecoveryVsCost == null ? ["REQUIRES_REIMBURSEMENT_AND_COGS"] : [],
        MONEY_LANE_FORMULA_CONTRACT_V2.actual_recovery_vs_cost.formula,
        actualRecoveryVsCost != null ? "observed - (qty × cogs)" : null,
        actualRecoveryVsCost != null ? "actual" : "unknown",
      ),
      lost_profit_estimate: field(
        lostProfit,
        lostProfit != null,
        lostProfit == null ? ["LOST_PROFIT_REQUIRES_COMPLETE_INPUTS"] : [],
        MONEY_LANE_FORMULA_CONTRACT_V2.lost_profit_estimate.formula,
        lostProfit != null ? "estimated_profit_if_sold - max(recovery_vs_cost,0)" : null,
        lostProfit != null ? "actual" : "unknown",
        analysisStatus !== "complete",
      ),
      informational_sale_estimate: informationalSaleEstimate,
      analysis_status: analysisStatus,
      analysis_note: analysisNote,
    },
    unknown_fields: [],
    lane_blockers,
  };

  preview.unknown_fields = collectUnknownFields(preview);
  return preview;
}

export async function composeMoneyLanePreviewV2(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<MoneyLanePreviewV2Result> {
  const discovered = await discoverMoneyLaneSourcesV1(client, organizationId, storeId, options);
  const per_submission_money_preview_v2 = await Promise.all(
    discovered.per_submission.map((row) =>
      buildSubmissionPreviewV2(row, client, organizationId, storeId),
    ),
  );

  const n = discovered.pilot_submission_count || 1;
  const countKnown = (fn: (p: PerSubmissionMoneyPreviewV2) => boolean) =>
    per_submission_money_preview_v2.filter(fn).length;

  const nullTracking = verifyMoneyNullPreservationTracking(discovered.previews);
  const salePriceOk = verifySalePriceNotUsedAsCogsV2(per_submission_money_preview_v2);
  const nullOk = verifyNullPreservationV2(per_submission_money_preview_v2);
  const feeLabelOk = verifyFeeLabelNoMix(per_submission_money_preview_v2);

  const soldCoverage = countKnown((p) => p.sale_view.latest_sold_price.status === "known");
  const feeCoverage = countKnown((p) => p.amazon_fee_view.breakdown.status === "known");
  const settlementCoverage = countKnown((p) => p.settlement_view.net_settlement_amount.status === "known");
  const cogsCoverage = countKnown((p) => p.cost_recovery_view.approved_cogs_unit.status === "known");
  const recoveryCoverage = countKnown((p) => p.cost_recovery_view.recovery_value.status === "known");
  const reimbCoverage = countKnown((p) => p.reimbursement_view.observed_reimbursement.status === "known");
  const gapCoverage = countKnown((p) => p.open_gap_view.open_recovery_gap.status === "known");
  const profitLossCoverage = countKnown((p) => p.profit_loss_view.analysis_status === "complete");

  const unknown_fields_by_submission: Record<string, string[]> = {};
  for (const p of per_submission_money_preview_v2) {
    unknown_fields_by_submission[p.claim_submission_id] = p.unknown_fields;
  }

  const blockers = [
    ...(cogsCoverage === 0 ? ["COGS_MISSING_ALL_PILOT_SUBMISSIONS"] : []),
    ...(reimbCoverage === 0 ? ["NO_SAFE_REIMBURSEMENT_MATCH_ALL_PILOT"] : []),
    ...(profitLossCoverage === 0 ? ["PROFIT_LOSS_BLOCKED_UNTIL_COGS_AND_REIMBURSEMENT"] : []),
  ];

  const ready =
    n === 10 &&
    nullTracking.pass &&
    salePriceOk &&
    nullOk &&
    feeLabelOk &&
    soldCoverage === n &&
    feeCoverage === n &&
    settlementCoverage === n;

  const cogsStillMissing = cogsCoverage === 0;

  return {
    version: CLAIM_MONEY_LANE_PREVIEW_V2_VERSION,
    pilot_submission_count: n,
    formula_contract: MONEY_LANE_FORMULA_CONTRACT_V2,
    per_submission_money_preview_v2,
    sale_view_coverage: `${soldCoverage}/${n}`,
    fee_view_coverage: `${feeCoverage}/${n}`,
    settlement_view_coverage: `${settlementCoverage}/${n}`,
    cogs_coverage: `${cogsCoverage}/${n}`,
    recovery_value_coverage: `${recoveryCoverage}/${n}`,
    reimbursement_coverage: `${reimbCoverage}/${n}`,
    open_gap_coverage: `${gapCoverage}/${n}`,
    profit_loss_coverage: `${profitLossCoverage}/${n}`,
    unknown_fields_by_submission,
    blockers,
    actual_vs_estimated_fee_label_verification: feeLabelOk,
    sale_price_not_used_as_cogs_verification: salePriceOk,
    null_preservation_verification: nullTracking.pass && nullOk,
    SAFE_MONEY_LANE_PROFIT_LOSS_PREVIEW_READY: ready,
    SAFE_TO_UPDATE_REIMBURSEMENT_TRACKING_UI_WITH_PROFIT_LOSS: ready,
    SAFE_TO_PLAN_COGS_APPLY_EXECUTE: cogsStillMissing,
    SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY: true,
    NEXT_PROMPT: cogsStillMissing
      ? "PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 — apply interim FNSKU cogs_overrides for 6 pilot products then re-run money lane preview V2"
      : "PHASE-CLAIM-REIMBURSEMENT-TRACKING-PROFIT-LOSS-UI-V1 — wire profit/loss panel into Reimbursement Tracking drawer",
  };
}
