/**
 * PHASE-AMAZON-FEE-ADJUSTED-REIMBURSEMENT-ESTIMATE-MODEL-V1
 * Read-only calculation contract — Amazon estimated payout lane separate from internal COGS/loss.
 * No DB writes. No claim_candidates mutation.
 */

import {
  CLAIM_CALCULATION_HARD_RULES,
  COST_SOURCE_PRIORITY_CHAIN,
  SALE_PRICE_RULE,
} from "../claims/contracts/claim-family-quantity-money-formula-contract-v2";

/** Confidence tier for fee-adjusted payout estimate. */
export type FeeEstimateConfidence = "high" | "medium" | "low" | "unavailable";

/** Fee component keys modeled in V1. */
export type FeeComponentKey =
  | "referral_fee"
  | "fba_fulfillment_fee"
  | "closing_fee"
  | "variable_closing_fee"
  | "returns_processing_fee"
  | "monthly_storage_fee"
  | "low_inventory_level_fee"
  | "inbound_placement_fee"
  | "overage_aged_inventory_fee"
  | "category_specific_fee"
  | "other_settlement_fee";

/** Price source lane — sale context for Amazon payout estimate only. */
export type PriceSourceCode =
  | "transaction_sale_price"
  | "product_prices_listing"
  | "open_listings_price"
  | "manage_fba_inventory_price"
  | "manual_price_override"
  | "unavailable";

/** Fee estimate source lane. */
export type FeeSourceCode =
  | "product_fees_api"
  | "fee_preview_report"
  | "settlement_actual"
  | "fee_schedule_snapshot"
  | "manual_fee_override"
  | "unavailable";

export type FeeComponentEstimate = {
  component_key: FeeComponentKey;
  estimated_amount: number | null;
  source: FeeSourceCode;
  source_detail: string | null;
  effective_date: string | null;
  claim_family_context: string | null;
};

export type FeeAdjustedMoneyOutput = {
  latest_valid_sale_price: number | null;
  latest_valid_sale_price_source: PriceSourceCode;
  estimated_referral_fee: number | null;
  estimated_fba_fulfillment_fee: number | null;
  estimated_other_fees: number | null;
  estimated_total_amazon_fees: number | null;
  estimated_amazon_payout: number | null;
  internal_cost_loss: number | null;
  unit_cost_basis: number | null;
  clean_qty: number | null;
  observed_reimbursement: number | null;
  estimated_reimbursement_gap: number | null;
  confidence: FeeEstimateConfidence;
  confidence_reasons: string[];
  product_linkage_resolved: boolean;
  disputed_row_excluded: boolean;
  is_estimate_not_guaranteed: true;
};

/** Core formula — Amazon payout lane (Lane A). */
export const FEE_ADJUSTED_REIMBURSEMENT_FORMULA = {
  latest_valid_sale_price:
    "COALESCE(latest_transaction_sale_price, product_prices.amount, open_listings_price, manage_fba_inventory_price, manual_price_override) — NULL if none",
  estimated_referral_fee:
    "SUM(referral_fee component from highest-priority fee source per FEE_COMPONENT_PRIORITY_RULES)",
  estimated_fba_fulfillment_fee:
    "SUM(fba_fulfillment_fee component from highest-priority fee source)",
  estimated_other_fees:
    "SUM(closing_fee, variable_closing_fee, returns_processing_fee, storage_fee, low_inventory_level_fee, inbound_placement_fee, overage_aged_inventory_fee, category_specific_fee, other_settlement_fee) — only components applicable to claim context",
  estimated_total_amazon_fees:
    "estimated_referral_fee + estimated_fba_fulfillment_fee + estimated_other_fees — NULL if any required component unavailable for trusted money",
  estimated_amazon_payout:
    "CASE WHEN latest_valid_sale_price IS NOT NULL AND estimated_total_amazon_fees IS NOT NULL THEN latest_valid_sale_price - estimated_total_amazon_fees ELSE NULL END",
  internal_cost_loss:
    "CASE WHEN clean_qty IS NOT NULL AND unit_cost_basis IS NOT NULL THEN clean_qty * unit_cost_basis ELSE NULL END — separate lane; never uses sale price",
  observed_reimbursement:
    "COALESCE(SUM(amazon_reimbursements.amount_total), settlement_credit, safet.total_reimbursement_amount) for linked keys — separate lane; never overwrites estimate",
  estimated_reimbursement_gap:
    "CASE WHEN estimated_amazon_payout IS NOT NULL AND observed_reimbursement IS NOT NULL THEN estimated_amazon_payout - observed_reimbursement ELSE NULL END",
  disclaimer:
    "estimated_amazon_payout is an Amazon fee-adjusted sale estimate — NOT guaranteed payout; Product Fees API disclaimer applies",
} as const;

export const FEE_COMPONENT_PRIORITY_RULES: Record<
  FeeComponentKey,
  { priority: FeeSourceCode[]; formula_sketch: string; claim_families: string[] }
> = {
  referral_fee: {
    priority: ["product_fees_api", "fee_preview_report", "settlement_actual", "fee_schedule_snapshot", "manual_fee_override"],
    formula_sketch: "listing_price × category_rate_pct (+ min fee floor)",
    claim_families: ["fba_fee_overcharge", "catalog_listing_fee_category_mismatch"],
  },
  fba_fulfillment_fee: {
    priority: ["product_fees_api", "fee_preview_report", "settlement_actual", "fee_schedule_snapshot", "manual_fee_override"],
    formula_sketch: "tier_lookup(dim_weight=max(weight_lb, L×W×H/139), product_size_tier)",
    claim_families: ["fba_fee_overcharge", "dimension_weight_fee_issue"],
  },
  closing_fee: {
    priority: ["product_fees_api", "fee_schedule_snapshot", "settlement_actual", "manual_fee_override"],
    formula_sketch: "media/category closing schedule OR 0",
    claim_families: ["fba_fee_overcharge"],
  },
  variable_closing_fee: {
    priority: ["product_fees_api", "fee_schedule_snapshot", "settlement_actual", "manual_fee_override"],
    formula_sketch: "category-gated variable closing OR 0",
    claim_families: ["fba_fee_overcharge"],
  },
  returns_processing_fee: {
    priority: ["product_fees_api", "fee_preview_report", "settlement_actual", "fee_schedule_snapshot", "manual_fee_override"],
    formula_sketch: "tier_lookup(category, size, return_type) — include only when returns_processing_fee_issue family",
    claim_families: ["returns_processing_fee_issue"],
  },
  monthly_storage_fee: {
    priority: ["settlement_actual", "fee_preview_report", "fee_schedule_snapshot", "manual_fee_override"],
    formula_sketch: "avg_volume_cuft × avg_qty × rate_card[month,tier,age] — include only for storage claim families",
    claim_families: ["monthly_storage_fee_overcharge"],
  },
  low_inventory_level_fee: {
    priority: ["settlement_actual", "fee_preview_report", "fee_schedule_snapshot", "manual_fee_override"],
    formula_sketch: "per_unit_fee WHEN days_of_supply < threshold — include when low_inventory_fee_issue family or source exists",
    claim_families: ["low_inventory_fee_issue"],
  },
  inbound_placement_fee: {
    priority: ["settlement_actual", "fee_schedule_snapshot", "manual_fee_override"],
    formula_sketch: "per_unit × units by placement program — include when inbound_placement_fee_issue family",
    claim_families: ["inbound_placement_fee_issue"],
  },
  overage_aged_inventory_fee: {
    priority: ["settlement_actual", "fee_schedule_snapshot", "manual_fee_override"],
    formula_sketch: "aged inventory surcharge from settlement or schedule — include when expired/aged context",
    claim_families: ["expired_inventory_action_signal"],
  },
  category_specific_fee: {
    priority: ["product_fees_api", "fee_schedule_snapshot", "settlement_actual", "manual_fee_override"],
    formula_sketch: "category surcharge lines from API FeeDetailList or schedule",
    claim_families: ["catalog_listing_fee_category_mismatch", "fba_fee_overcharge"],
  },
  other_settlement_fee: {
    priority: ["settlement_actual", "manual_fee_override"],
    formula_sketch: "unmapped Amazon fee line from settlements/transactions when present",
    claim_families: ["fba_fee_overcharge", "settlement_refund_anomaly"],
  },
};

export const PRODUCT_FEES_API_CONTRACT = {
  api_version: "products/fees/v0",
  operations: [
    {
      name: "getMyFeesEstimateForASIN",
      method: "POST",
      path: "/products/fees/v0/items/{Asin}/feesEstimate",
      required_body: ["FeesEstimateRequest.MarketplaceId", "FeesEstimateRequest.PriceToEstimateFees.ListingPrice", "FeesEstimateRequest.IsAmazonFulfilled", "FeesEstimateRequest.Identifier"],
      maps_to_components: ["referral_fee", "fba_fulfillment_fee", "closing_fee", "variable_closing_fee", "returns_processing_fee", "category_specific_fee"],
    },
    {
      name: "getMyFeesEstimateForSKU",
      method: "POST",
      path: "/products/fees/v0/listings/{SellerSKU}/feesEstimate",
      required_body: ["FeesEstimateRequest.MarketplaceId", "FeesEstimateRequest.PriceToEstimateFees.ListingPrice", "FeesEstimateRequest.IsAmazonFulfilled", "FeesEstimateRequest.Identifier"],
      maps_to_components: ["referral_fee", "fba_fulfillment_fee", "closing_fee", "variable_closing_fee"],
    },
    {
      name: "getMyFeesEstimates",
      method: "POST",
      path: "/products/fees/v0/feesEstimate",
      batch_limit: 20,
      required_body: ["FeesEstimateRequestList (≤20 items)"],
      maps_to_components: ["all FeeDetailList components"],
    },
  ],
  response_mapping: {
    referral_fee: "FeesEstimateResult.FeesEstimate.FeeDetailList[FeeType=ReferralFee].FeeAmount.Amount",
    fba_fulfillment_fee: "FeesEstimateResult.FeesEstimate.FeeDetailList[FeeType=FBAFees|FulfillmentFee].FeeAmount.Amount",
    variable_closing_fee: "FeeDetailList[FeeType=VariableClosingFee]",
    closing_fee: "FeeDetailList[FeeType=ClosingFee]",
    returns_processing_fee: "FeeDetailList when category exposes returns component",
    category_specific_fee: "remaining FeeDetailList lines not mapped above",
  },
  required_inputs: ["asin OR sku", "marketplace_id", "listing_price", "is_amazon_fulfilled", "currency"],
  disclaimer: "Amazon: estimates not guaranteed; may differ from actual shipped dimensions",
  repo_status: "not_implemented",
  roles_required: ["Pricing", "Product Listing"],
  cache_policy: "Optional fee_estimate_snapshots adjunct with fetched_at — never treated as observed charge",
} as const;

export const FEE_PREVIEW_FALLBACK_CONTRACT = {
  sp_report_type: "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA",
  table: "amazon_fee_preview",
  columns: {
    price: "listing/sale price hint from report row",
    estimated_fee: "aggregate estimated FBA+referral from report",
    raw_data: "per-component columns: estimated-referral-fee-per-unit, expected-domestic-fulfilment-fee-per-unit, product-size-tier, etc.",
  },
  component_extraction: {
    referral_fee: "raw_data['estimated-referral-fee-per-unit'] OR parsed referral column",
    fba_fulfillment_fee: "raw_data['expected-domestic-fulfilment-fee-per-unit'] OR estimated_fee - referral",
    category_specific_fee: "raw_data category surcharge columns when present",
  },
  join_keys: ["organization_id", "store_id", "fnsku|asin|sku via product_identifier_map"],
  precedence: "Used when Product Fees API unavailable or stale > 7d",
  empty_table_rule: "NULL unavailable — not zero",
  repo_status: "importer_live; staging may be empty on smoke org",
} as const;

export const SETTLEMENT_ACTUAL_FEE_FALLBACK = {
  tables: ["amazon_settlements", "amazon_transactions", "financial_reference_resolver"],
  use: "Observed fee lines for benchmark AND fee estimate fallback tier 3 — never primary estimate when API/report available",
  component_mapping: {
    referral_fee: "selling_fees / referral fee transaction type",
    fba_fulfillment_fee: "fba_fees / fulfillment fee lines",
    monthly_storage_fee: "FBA inventory storage fee lines",
    returns_processing_fee: "returns processing fee lines",
    low_inventory_level_fee: "low inventory level fee lines",
    inbound_placement_fee: "inbound placement service fee lines",
    other_settlement_fee: "other-transaction-fees / unmapped fee type",
  },
  observed_vs_estimate: "Settlement lines populate observed lane; may inform fee_overcharge_gap = charged - expected",
  join_keys: ["order_id", "sku", "fnsku", "asin", "settlement_id", "product_id via map"],
} as const;

export const CATEGORY_FEE_SNAPSHOT_FALLBACK_RULES = {
  proposed_table: "amazon_fee_schedule_snapshots",
  required_columns: [
    "schedule_key",
    "component_key",
    "marketplace_id",
    "category_or_tier",
    "rate_value",
    "rate_unit",
    "effective_date",
    "source_url",
    "captured_at",
    "created_by",
  ],
  usage: "Tier 4 fallback only — display effective_date + source_url in Product Story",
  refresh: "Quarterly or when Amazon announces fee changes",
  never: "Do not treat snapshot as observed charge or guaranteed payout",
  manual_override: "Tier 5 — workspace_settings.module_configs.fee_overrides with audit_log entry required",
} as const;

export const PRICE_SOURCE_PRIORITY_RULES = [
  "1. latest valid transaction sale price for same SKU/ASIN (amazon_settlements.product_sales / order item price)",
  "2. active listing price / product_prices.amount (observed_at DESC, store-scoped)",
  "3. Open Listings Report Lite price / amazon_manage_fba_inventory your_price",
  "4. manual price override with audit (workspace_settings.module_configs.price_overrides)",
  "5. unavailable — NULL not zero",
] as const;

export const INTERNAL_COST_LANE_CONTRACT = {
  lane_name: "internal_cost_loss",
  formula: FEE_ADJUSTED_REIMBURSEMENT_FORMULA.internal_cost_loss,
  unit_cost_priority: [...COST_SOURCE_PRIORITY_CHAIN],
  forbidden: [
    "product_prices.amount as unit_cost",
    "latest_valid_sale_price as unit_cost",
    "listing price as recovery substitute",
    "zero when unknown",
  ],
  clean_qty_rule: "claim_quantity after clean/disputed filter — disputed rows excluded from trusted money",
  separation: "internal_cost_loss NEVER subtracted from estimated_amazon_payout; displayed as separate lane in Product Story and Claim Center",
  sellersnap: "product_cost_snapshots.unit_cost when wired — planned table",
} as const;

export const OBSERVED_REIMBURSEMENT_LANE_CONTRACT = {
  lane_name: "observed_reimbursement",
  formula: FEE_ADJUSTED_REIMBURSEMENT_FORMULA.observed_reimbursement,
  sources_priority: [
    "amazon_reimbursements.amount_total (approval_date DESC, matched fnsku/asin/sku)",
    "amazon_settlements reimbursement/credit lines",
    "financial_reference_resolver linked amounts",
    "amazon_safet_claims.total_reimbursement_amount when non-empty",
  ],
  separation: "Never overwrites estimated_amazon_payout or internal_cost_loss",
  gap_formula: FEE_ADJUSTED_REIMBURSEMENT_FORMULA.estimated_reimbursement_gap,
  trusted_money_gate: "product_linkage_resolved = true before displaying observed in claim-ready context",
  disputed_exclusion: "disputed/source-conflict rows excluded from claim-ready observed sum",
} as const;

export const MISSING_PRODUCT_FIELDS = {
  identifiers: ["asin", "fnsku", "sku", "product_id via product_identifier_map"],
  catalog: ["product_category", "product_type", "browse_node", "fulfillment_channel"],
  dimensions_weight: [
    "length_value",
    "width_value",
    "height_value",
    "dimension_unit",
    "weight_value",
    "weight_unit",
    "packaging_level=unit (PC04)",
  ],
  price: ["product_prices row OR transaction sale price OR listing price"],
  sources: {
    internal_verified: "product_packaging_dimensions_current (PC04)",
    amazon_catalog: "Catalog Items API attributes.dimensions",
    fee_preview_hints: "amazon_fee_preview.raw_data size tier columns",
    manage_fba: "amazon_manage_fba_inventory.your_price",
  },
  linkage_gate: "product_identifier_map exact match required before trusted money",
} as const;

export const MISSING_FEE_FIELDS = {
  product_fees_api: ["live client wrapper", "fee_estimate_snapshots cache table (Maysam approval)", "marketplace_id on store adapter"],
  fee_preview: ["amazon_fee_preview rows may be empty on staging", "resolved_product_id backfill (dimensions audit)"],
  storage: ["amazon_monthly_storage_fees rows may be empty", "cubic_feet derivation from PC04"],
  specialty_reports: [
    "Low-Inventory-Level Fee report importer",
    "Returns Processing Fee report importer",
    "Inbound Placement Service Fees importer",
  ],
  cost_spine: ["product_cost_snapshots table not migrated", "SellerSnap COGS importer not wired"],
  category_map: ["browse_node → referral rate mapping for catalog_listing_fee_category_mismatch"],
} as const;

export const CONFIDENCE_RULES_FEE_ADJUSTED = {
  high:
    "product_linkage_resolved AND latest_valid_sale_price from transaction or listing AND fee components from Product Fees API FeeDetailList (≥2 components) AND NOT disputed_row",
  medium:
    "product_linkage_resolved AND (Fee Preview row only OR API without PC04 dim verification OR sale price from manage_fba only)",
  low: "fallback fee_schedule_snapshot only OR single component estimate OR stale source >45d",
  unavailable:
    "product_linkage unresolved OR latest_valid_sale_price NULL OR all fee sources empty OR disputed_row — money fields NULL not zero",
  hard_rules: CLAIM_CALCULATION_HARD_RULES,
  sale_price_rule: SALE_PRICE_RULE,
  trusted_money_gate: "confidence high OR (medium AND product_linkage_resolved AND NOT disputed_row)",
} as const;

export type FeeAdjustedEstimateInput = {
  product_linkage_resolved: boolean;
  disputed_row_excluded: boolean;
  clean_qty: number | null;
  unit_cost_basis: number | null;
  latest_valid_sale_price: number | null;
  latest_valid_sale_price_source: PriceSourceCode;
  fee_components: Partial<Record<FeeComponentKey, { amount: number | null; source: FeeSourceCode }>>;
  observed_reimbursement: number | null;
  claim_family_context?: string | null;
};

/** NULL-safe pure evaluator — no I/O. */
export function computeFeeAdjustedMoneyOutput(input: FeeAdjustedEstimateInput): FeeAdjustedMoneyOutput {
  const reasons: string[] = [];

  if (!input.product_linkage_resolved) {
    reasons.push("product_linkage_unresolved");
  }
  if (input.disputed_row_excluded) {
    reasons.push("disputed_row_excluded_from_claim_ready");
  }

  const referral = input.fee_components.referral_fee?.amount ?? null;
  const fba = input.fee_components.fba_fulfillment_fee?.amount ?? null;

  const otherKeys: FeeComponentKey[] = [
    "closing_fee",
    "variable_closing_fee",
    "returns_processing_fee",
    "monthly_storage_fee",
    "low_inventory_level_fee",
    "inbound_placement_fee",
    "overage_aged_inventory_fee",
    "category_specific_fee",
    "other_settlement_fee",
  ];
  let otherSum = 0;
  let otherHasValue = false;
  for (const k of otherKeys) {
    const v = input.fee_components[k]?.amount;
    if (v != null) {
      otherSum += v;
      otherHasValue = true;
    }
  }
  const estimated_other_fees = otherHasValue ? otherSum : null;

  const feeParts = [referral, fba, estimated_other_fees].filter((x) => x != null) as number[];
  const estimated_total_amazon_fees = feeParts.length > 0 ? feeParts.reduce((a, b) => a + b, 0) : null;

  const sale = input.latest_valid_sale_price;
  const estimated_amazon_payout =
    sale != null && estimated_total_amazon_fees != null ? sale - estimated_total_amazon_fees : null;

  const internal_cost_loss =
    input.clean_qty != null && input.unit_cost_basis != null
      ? input.clean_qty * input.unit_cost_basis
      : null;

  const estimated_reimbursement_gap =
    estimated_amazon_payout != null && input.observed_reimbursement != null
      ? estimated_amazon_payout - input.observed_reimbursement
      : null;

  let confidence: FeeEstimateConfidence = "unavailable";
  if (!input.product_linkage_resolved || input.disputed_row_excluded) {
    confidence = "unavailable";
  } else if (sale == null || estimated_total_amazon_fees == null) {
    confidence = "unavailable";
    reasons.push("missing_sale_or_fee_inputs");
  } else {
    const apiComponentCount = Object.values(input.fee_components).filter(
      (c) => c && c.source === "product_fees_api" && c.amount != null,
    ).length;
    if (apiComponentCount >= 2 && input.latest_valid_sale_price_source === "transaction_sale_price") {
      confidence = "high";
    } else if (
      Object.values(input.fee_components).some((c) => c?.source === "fee_preview_report") ||
      apiComponentCount >= 1
    ) {
      confidence = "medium";
    } else if (Object.values(input.fee_components).some((c) => c?.source === "fee_schedule_snapshot")) {
      confidence = "low";
    } else {
      confidence = "unavailable";
      reasons.push("no_trusted_fee_source");
    }
  }

  return {
    latest_valid_sale_price: sale,
    latest_valid_sale_price_source: input.latest_valid_sale_price_source,
    estimated_referral_fee: referral,
    estimated_fba_fulfillment_fee: fba,
    estimated_other_fees,
    estimated_total_amazon_fees,
    estimated_amazon_payout,
    internal_cost_loss,
    unit_cost_basis: input.unit_cost_basis,
    clean_qty: input.clean_qty,
    observed_reimbursement: input.observed_reimbursement,
    estimated_reimbursement_gap,
    confidence,
    confidence_reasons: reasons,
    product_linkage_resolved: input.product_linkage_resolved,
    disputed_row_excluded: input.disputed_row_excluded,
    is_estimate_not_guaranteed: true,
  };
}

export const SAFE_TO_IMPLEMENT_FEE_ESTIMATE_READMODEL = "yes" as const;

export const NEXT_EXACT_PROMPT_FEE_ADJUSTED = `PHASE-AMAZON-FEE-ADJUSTED-REIMBURSEMENT-READMODEL-IMPLEMENT-V1

Mode: read-model implement — pure functions + GET /api/products/[id]/fee-adjusted-estimate (SELECT only).

Do not write DB. Do not mutate claim_candidates. Do not call Product Fees API in production without staging gate.

Implement:
1. lib/fees/fee-adjusted-estimate-readmodel.ts — join product_identifier_map, product_prices, amazon_fee_preview, reimbursements, settlements
2. API handler returning FeeAdjustedMoneyOutput + component breakdown + confidence
3. Product Story / Claim Center money panel — three lanes: estimated_amazon_payout | internal_cost_loss | observed_reimbursement
4. Smoke on X004LKS4VD, B0000B11UX, one reimbursement product, one fee_preview product, one storage product

Prerequisite: Product Fees API client wrapper (staging gated) OR Fee Preview row present for medium confidence demos.` as const;
