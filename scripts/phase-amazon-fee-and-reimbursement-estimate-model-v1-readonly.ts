/**
 * PHASE-AMAZON-FEE-AND-REIMBURSEMENT-ESTIMATE-MODEL-V1
 * Read-only fee/reimbursement estimate model contract — no DB writes, no Amazon API calls.
 *
 *   npx tsx scripts/phase-amazon-fee-and-reimbursement-estimate-model-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  CLAIM_CALCULATION_HARD_RULES,
  CONFIDENCE_RULES_V2,
  COST_SOURCE_PRIORITY_CHAIN,
  GLOBAL_FORMULA_PRIMITIVES,
  SALE_PRICE_RULE,
} from "../lib/claims/contracts/claim-family-quantity-money-formula-contract-v2";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-fee-and-reimbursement-estimate-model-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

/** Official Amazon references — verify effective dates before production use. */
const OFFICIAL_SOURCES = [
  {
    id: "spapi_product_fees_api",
    title: "Product Fees API",
    url: "https://developer-docs.amazon.com/sp-api/docs/product-fees-api",
    use: "Primary live fee estimate — getMyFeesEstimateForASIN/SKU, getMyFeesEstimates (batch ≤20)",
  },
  {
    id: "spapi_fees_asin",
    title: "getMyFeesEstimateForASIN",
    url: "https://developer-docs.amazon.com/sp-api/docs/get-product-fee-estimates-asin",
    use: "POST /products/fees/v0/items/{Asin}/feesEstimate — requires ListingPrice, IsAmazonFulfilled, Identifier",
  },
  {
    id: "fee_preview_report",
    title: "Fee Preview report (GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA)",
    url: "https://sellercentral.amazon.com/help/hub/reference/G200336450",
    use: "Bulk SKU/FNSKU fee snapshot — maps to amazon_fee_preview in repo",
  },
  {
    id: "storage_fees_report",
    title: "Monthly Inventory Storage Fees (GET_FBA_STORAGE_FEE_CHARGES_DATA)",
    url: "https://sellercentral.amazon.com/help/hub/reference/G200612770",
    use: "Charged storage by month — maps to amazon_monthly_storage_fees",
  },
  {
    id: "fba_fees_help",
    title: "FBA fulfillment fee help (size tiers)",
    url: "https://sellercentral.amazon.com/help/hub/reference/G201411300",
    use: "Fallback tier schedule snapshot only — superseded by Product Fees API when available",
  },
  {
    id: "referral_fees_help",
    title: "Referral fee categories",
    url: "https://sellercentral.amazon.com/help/hub/reference/G200336450",
    use: "Category % fallback snapshot — Product Fees API returns ReferralFee component",
  },
  {
    id: "revenue_calculator",
    title: "Amazon Revenue Calculator (Seller Central)",
    url: "https://sellercentral.amazon.com/hz/fba/profitabilitycalculator/index",
    use: "Human benchmark only — not programmatic source; aligns with Product Fees API behavior",
  },
] as const;

type FeeComponent = {
  component_key: string;
  display_name: string;
  estimate_sources_priority: string[];
  observed_sources: string[];
  required_inputs: string[];
  formula_sketch: string;
  claim_families: string[];
  listing_profitability: boolean;
  product_story_panel: string | null;
  fallback_snapshot_allowed: boolean;
  notes: string;
};

const FEE_COMPONENTS: FeeComponent[] = [
  {
    component_key: "referral_fee",
    display_name: "Referral fee (category %)",
    estimate_sources_priority: [
      "1. Product Fees API FeeDetailList ReferralFee",
      "2. amazon_fee_preview.raw_data estimated-referral-fee-per-unit",
      "3. Fallback snapshot fee_schedule_referral (category_id, effective_date, rate_pct, source_url)",
    ],
    observed_sources: ["amazon_settlements.selling_fees", "financial_reference_resolver"],
    required_inputs: ["asin", "sku", "marketplace_id", "listing_price", "product_category"],
    formula_sketch: "referral_fee = listing_price × category_rate_pct (+ min fee floor if applicable)",
    claim_families: ["fba_fee_overcharge", "fee_or_dimension_overcharge"],
    listing_profitability: true,
    product_story_panel: "Fees / Referral",
    fallback_snapshot_allowed: true,
    notes: "Product Fees API uses catalog category; verify category from Listings/Catalog Items API",
  },
  {
    component_key: "fba_fulfillment_fee",
    display_name: "FBA fulfillment fee (size/weight tier)",
    estimate_sources_priority: [
      "1. Product Fees API FBAFees / FulfillmentFee component",
      "2. amazon_fee_preview.estimated_fee (aggregate) + raw_data size tier columns",
      "3. Fallback snapshot fba_fulfillment_tier_schedule (effective_date, size_tier, weight_band, fee_usd, source_url)",
    ],
    observed_sources: ["amazon_settlements.fba_fees", "amazon_fee_preview", "financial_reference_resolver"],
    required_inputs: ["asin", "fnsku", "sku", "length_in", "width_in", "height_in", "weight_lb", "is_fba"],
    formula_sketch: "fulfillment_fee = tier_lookup(dim_weight=max(actual_weight, L×W×H/139), product_size_tier)",
    claim_families: ["fba_fee_overcharge", "dimension_weight_fee_issue"],
    listing_profitability: true,
    product_story_panel: "Fees / FBA fulfillment",
    fallback_snapshot_allowed: true,
    notes: "Amazon warns API estimate may differ from actual shipped size; PC04 internal dims for dispute evidence",
  },
  {
    component_key: "variable_closing_fee",
    display_name: "Variable closing fee",
    estimate_sources_priority: [
      "1. Product Fees API VariableClosingFee component (category-gated)",
      "2. Fallback snapshot variable_closing_fee_categories",
    ],
    observed_sources: ["amazon_settlements.other_transaction_fees"],
    required_inputs: ["product_category", "listing_price", "is_media_category"],
    formula_sketch: "closing_fee = category_schedule OR 0",
    claim_families: ["fba_fee_overcharge"],
    listing_profitability: true,
    product_story_panel: "Fees / Closing",
    fallback_snapshot_allowed: true,
    notes: "Applies only to select media categories",
  },
  {
    component_key: "monthly_storage_fee",
    display_name: "Monthly inventory storage fee",
    estimate_sources_priority: [
      "1. amazon_monthly_storage_fees report (charged)",
      "2. Recompute: cubic_feet × rate(month, size_tier, age) from PC04 dims",
      "3. Fallback snapshot storage_rate_card (month, tier, rate_per_cuft, source_url)",
    ],
    observed_sources: ["amazon_monthly_storage_fees", "amazon_settlements FBA storage lines"],
    required_inputs: ["fnsku", "asin", "storage_month", "cubic_feet", "product_size_tier", "inventory_age_bucket"],
    formula_sketch: "storage_fee = avg_volume_cuft × avg_qty_on_hand × rate_card[month,tier,age]",
    claim_families: ["monthly_storage_fee_overcharge", "storage_fee_issue"],
    listing_profitability: false,
    product_story_panel: "Fees / Storage",
    fallback_snapshot_allowed: true,
    notes: "Long-term vs standard rates; oversize multiplier — use report charged amount as observed",
  },
  {
    component_key: "returns_processing_fee",
    display_name: "Returns processing fee",
    estimate_sources_priority: [
      "1. Product Fees API (when returns fee component returned for category/size)",
      "2. Returns Processing Fee report (file-first — sample zip unsupported in repo)",
      "3. Fallback snapshot returns_processing_fee_schedule",
    ],
    observed_sources: ["amazon_settlements returns fee lines", "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA fee columns if present"],
    required_inputs: ["category", "size_tier", "return_reason", "is_fba_return"],
    formula_sketch: "returns_processing_fee = tier_lookup(category, size, return_type)",
    claim_families: ["returns_processing_fee_issue"],
    listing_profitability: true,
    product_story_panel: "Fees / Returns processing",
    fallback_snapshot_allowed: true,
    notes: "Report importer not wired — file-first until SP-API report type confirmed",
  },
  {
    component_key: "low_inventory_fee",
    display_name: "Low inventory level fee",
    estimate_sources_priority: [
      "1. Low-Inventory-Level Fee report (file-first — sample zip unsupported)",
      "2. Product Fees API if component exposed",
      "3. Fallback snapshot low_inventory_fee_rules",
    ],
    observed_sources: ["amazon_settlements fee lines"],
    required_inputs: ["sku", "fnsku", "days_of_supply", "threshold"],
    formula_sketch: "low_inv_fee = per_unit_fee WHEN days_of_supply < threshold",
    claim_families: ["low_inventory_fee_issue"],
    listing_profitability: true,
    product_story_panel: "Fees / Low inventory",
    fallback_snapshot_allowed: true,
    notes: "Not in AMAZON_REPORT_REGISTRY today",
  },
  {
    component_key: "inbound_placement_fee",
    display_name: "Inbound placement service fee",
    estimate_sources_priority: [
      "1. Inbound Placement Service Fees report (file-first — sample zip unsupported)",
      "2. Fallback snapshot inbound_placement_fee_schedule",
    ],
    observed_sources: ["amazon_settlements", "amazon_inbound_performance"],
    required_inputs: ["shipment_id", "placement_option", "units"],
    formula_sketch: "placement_fee = per_unit × units by placement program",
    claim_families: ["inbound_placement_fee_issue"],
    listing_profitability: false,
    product_story_panel: "Fees / Inbound",
    fallback_snapshot_allowed: true,
    notes: "Inbound performance table exists; placement fee report not wired",
  },
];

const ESTIMATED_REIMBURSEMENT_MODELS = [
  {
    model_key: "cost_based_recovery",
    display_name: "Cost-based recovery estimate",
    formula:
      "estimated_reimbursement = claim_quantity × actual_cost_basis WHERE actual_cost_basis from COST_SOURCE_PRIORITY_CHAIN",
    inputs: ["claim_quantity", "cogs_overrides", "product_cost_snapshots", "return_items.estimated_value"],
    use_cases: ["ORBIT/FRA recovery", "customer_return_not_reimbursed", "inventory lost/damaged/disposed"],
    sale_price_used: false,
    confidence: "money_high when cost_snapshots; else NULL",
  },
  {
    model_key: "sale_proceeds_based",
    display_name: "Sale proceeds-based estimate (display / upper bound only)",
    formula:
      "display_context = latest_sale_price × claim_quantity — NOT used as estimated_reimbursement unless policy explicitly enables comparison mode",
    inputs: ["product_prices.amount", "amazon_settlements.product_sales", "recent order price"],
    use_cases: ["Product Story sale context", "listing profitability display"],
    sale_price_used: true,
    confidence: "display_only — never substitutes COGS",
  },
  {
    model_key: "fee_adjusted_sale_estimate",
    display_name: "Fee-adjusted sale estimate (theoretical net proceeds)",
    formula:
      "theoretical_net = latest_sale_price - referral_fee_est - fba_fulfillment_fee_est - variable_closing_fee_est - returns_processing_fee_est (each from API/report priority)",
    inputs: ["listing_price", "Product Fees API FeeDetailList", "amazon_fee_preview", "category"],
    use_cases: ["listing profitability", "Product Story money panel comparison lane"],
    sale_price_used: true,
    confidence: "medium — estimates not guaranteed per Amazon Product Fees API disclaimer",
  },
  {
    model_key: "observed_reimbursement_benchmark",
    display_name: "Observed Amazon reimbursement benchmark",
    formula:
      "observed = SUM(amazon_reimbursements.amount_total) per matched keys; benchmark_median = PERCENTILE_CONT(0.5) historical by reason_code × size_tier",
    inputs: ["amazon_reimbursements", "financial_reference_resolver", "reason", "fnsku"],
    use_cases: ["partial_incorrect_reimbursement", "missing_reimbursement gap", "Claim Center observed lane"],
    sale_price_used: false,
    confidence: "high when historical match cardinality ≥ 3 same reason/tier",
  },
  {
    model_key: "reimbursement_gap",
    display_name: "Reimbursement gap (estimate vs observed)",
    formula: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
    inputs: ["estimated_reimbursement model output", "observed_reimbursement"],
    use_cases: ["claim expected reimbursement", "ORBIT fight list"],
    sale_price_used: false,
    confidence: "requires both lanes non-NULL",
  },
];

const API_VS_REPORT_PRIORITY = {
  rule:
    "Live Product Fees API > seller-specific report row (Fee Preview / Storage) > settlement observed line > fallback snapshot schedule with effective_date",
  product_fees_api: {
    operations: [
      "getMyFeesEstimateForASIN",
      "getMyFeesEstimateForSKU",
      "getMyFeesEstimates (batch ≤20)",
    ],
    endpoint: "POST /products/fees/v0/items/{Asin|Sku}/feesEstimate",
    required_body: ["MarketplaceId", "PriceToEstimateFees.ListingPrice", "IsAmazonFulfilled", "Identifier"],
    disclaimer: "Estimates not guaranteed; may differ from actual shipped dimensions",
    repo_status: "not_implemented",
    roles_required: ["Pricing", "Product Listing"],
  },
  reports: {
    fee_preview: {
      sp_type: "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA",
      table: "amazon_fee_preview",
      repo_status: "importer_live_api_worker_planned",
    },
    monthly_storage: {
      sp_type: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
      table: "amazon_monthly_storage_fees",
      repo_status: "importer_live_api_worker_planned",
    },
  },
  settlements_transactions: {
    use: "observed lane only — not primary estimate",
    tables: ["amazon_settlements", "amazon_transactions", "financial_reference_resolver"],
  },
  revenue_calculator: {
    use: "human QA benchmark only — do not scrape",
  },
};

const FORMULA_PRIORITY_RULES = [
  "Lane 1 actual_cost_basis: cogs_overrides → product_cost_snapshots → purchase/landed cost → manual cost → return_items.estimated_value → NULL (never product_prices, never unit_sale_price)",
  "Lane 2 sale context: product_prices / listing price / recent settlement sale — display-only unless fee_adjusted_sale model explicitly selected",
  "Lane 3 fee estimate: Product Fees API component sum > Fee Preview row > snapshot schedule",
  "Lane 4 estimated_reimbursement: default cost_based_recovery for inventory/return families; fee_overcharge_gap for fee families; NULL when inputs missing",
  "Lane 5 observed_reimbursement: amazon_reimbursements + settlements + FRR + SAFE-T when non-empty — separate field, never overwrites estimate",
  "Empty connector = unavailable NULL, not zero",
  "Product linkage required before trusted Product Story money panel",
];

const REQUIRED_PRODUCT_FIELDS = {
  identifiers: ["asin", "fnsku", "sku", "product_id via product_identifier_map"],
  catalog: ["product_category", "product_type", "brand", "fulfillment_channel"],
  dimensions_weight: [
    "length_value",
    "width_value",
    "height_value",
    "dimension_unit",
    "weight_value",
    "weight_unit",
    "packaging_level=unit",
  ],
  sources: {
    internal_verified: "product_packaging_dimensions_current (PC04)",
    amazon_catalog: "Catalog Items API attributes.dimensions",
    fee_preview_hints: "amazon_fee_preview.raw_data size tier columns",
  },
};

const REQUIRED_COST_FIELDS = {
  priority: [...COST_SOURCE_PRIORITY_CHAIN],
  planned_table: "product_cost_snapshots (unit_cost, effective_date, source_code, sku|fnsku|asin)",
  sellersnap: "external CSV → cost spine — NOT product_prices",
  forbidden: ["product_prices.amount as COGS", "unit_sale_price as COGS", "listing price as recovery substitute"],
};

const REQUIRED_DIMENSION_FIELDS = {
  pc04: "product_packaging_dimensions_current + product_packaging_profile_versions",
  normalization: "Convert to inches/lb before dim_weight = max(weight_lb, L×W×H/139)",
  use: ["fba_fulfillment_fee recompute", "storage cubic feet", "dimension_weight_fee_issue claims"],
};

const FALLBACK_SNAPSHOT_RULES = {
  table_name_proposed: "amazon_fee_schedule_snapshots",
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
  ],
  usage: "Only when Product Fees API and seller reports unavailable; display effective_date + source_url in Product Story",
  refresh: "Manual quarterly review or when Amazon announces fee changes",
  never: "Do not treat snapshot as observed charge",
};

const IMPLEMENTATION_PHASES = [
  {
    phase: "1",
    name: "Fee estimate read-model contract module",
    deliverables: [
      "lib/fees/amazon-fee-estimate-model-v1.ts (types + pure functions)",
      "Wire Product Fees API client wrapper (staging gated)",
      "Persist API responses to fee_estimate_snapshots adjunct (read-model cache — future table approval)",
    ],
  },
  {
    phase: "2",
    name: "Observed + estimate join layer",
    deliverables: [
      "Join amazon_fee_preview + settlements + reimbursements by identifier",
      "Expose GET /api/products/[id]/fee-estimates read-only",
      "Product Story money panel consumes three lanes",
    ],
  },
  {
    phase: "3",
    name: "COGS spine + ORBIT alignment",
    deliverables: [
      "SellerSnap → product_cost_snapshots",
      "Remove unit_sale_price fallback from ORBIT buildCogsResolver",
      "recovery_value = qty × cogs_unit only",
    ],
  },
  {
    phase: "4",
    name: "Claim family fee engines",
    deliverables: [
      "fba_fee_overcharge recompute",
      "monthly_storage_fee_overcharge volume proof",
      "returns/low-inventory/inbound fee reports when importers exist",
    ],
  },
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function stagingCensus(client: pg.Client): Promise<Record<string, unknown>> {
  const q = async (sql: string, params: unknown[] = []) => {
    try {
      return (await client.query(sql, params)).rows[0];
    } catch {
      return { error: "query_failed" };
    }
  };
  return {
    amazon_fee_preview: await q(
      `SELECT COUNT(*)::int AS rows, MAX(created_at)::text AS last_created
       FROM amazon_fee_preview WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
      [ORG, STORE],
    ),
    amazon_monthly_storage_fees: await q(
      `SELECT COUNT(*)::int AS rows, MAX(created_at)::text AS last_created
       FROM amazon_monthly_storage_fees WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
      [ORG, STORE],
    ),
    amazon_reimbursements: await q(
      `SELECT COUNT(*)::int AS rows,
              COUNT(*) FILTER (WHERE amount_total IS NOT NULL)::int AS with_amount,
              MAX(approval_date)::text AS last_approval
       FROM amazon_reimbursements WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
      [ORG, STORE],
    ),
    product_prices: await q(
      `SELECT COUNT(*)::int AS rows FROM product_prices pp
       JOIN products p ON p.id=pp.product_id
       WHERE p.organization_id=$1::uuid`,
      [ORG],
    ),
    product_cost_snapshots_exists: await q(
      `SELECT to_regclass('public.product_cost_snapshots') IS NOT NULL AS exists`,
    ),
    pc04_dims: await q(
      `SELECT COUNT(*)::int AS rows FROM product_packaging_dimensions_current d
       JOIN products p ON p.id=d.product_id WHERE p.organization_id=$1::uuid`,
      [ORG],
    ),
  };
}

async function main(): Promise<void> {
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  let staging_census: Record<string, unknown> = {};
  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (pgUrl.includes(STAGING_REF)) {
    const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    staging_census = await stagingCensus(c);
    await c.end();
  }

  const fee_components_matrix = FEE_COMPONENTS;
  const referral_fee_model = FEE_COMPONENTS.find((c) => c.component_key === "referral_fee");
  const fba_fulfillment_fee_model = FEE_COMPONENTS.find((c) => c.component_key === "fba_fulfillment_fee");
  const storage_fee_model = FEE_COMPONENTS.find((c) => c.component_key === "monthly_storage_fee");
  const returns_processing_fee_model = FEE_COMPONENTS.find((c) => c.component_key === "returns_processing_fee");
  const low_inventory_fee_model = FEE_COMPONENTS.find((c) => c.component_key === "low_inventory_fee");
  const inbound_placement_fee_model = FEE_COMPONENTS.find((c) => c.component_key === "inbound_placement_fee");

  const confidence_rules = {
    ...CONFIDENCE_RULES_V2,
    fee_estimate_high: "Product Fees API returned FeeDetailList + PC04 dims align with preview tier",
    fee_estimate_medium: "Fee Preview report row only OR API without dim verification",
    fee_estimate_low: "Fallback snapshot schedule only",
    fee_estimate_unavailable: "No API, no report, no snapshot — NULL not 0",
    reimbursement_estimate_high: "cost_basis from snapshots + observed historical median within 15%",
    reimbursement_estimate_medium: "cost_basis from return_items.estimated_value",
    reimbursement_estimate_unavailable: "actual_cost_basis NULL",
    hard_rules: CLAIM_CALCULATION_HARD_RULES,
    sale_price_rule: SALE_PRICE_RULE,
  };

  const SAFE_TO_IMPLEMENT_FEE_ESTIMATE_READMODEL = "yes_with_conditions";

  const summary = {
    prompt: "PHASE-AMAZON-FEE-AND-REIMBURSEMENT-ESTIMATE-MODEL-V1",
    run_id: rid,
    mode: "read_only_research_contract",
    official_sources: OFFICIAL_SOURCES,
    existing_repo_contracts: [
      "lib/claims/contracts/claim-family-quantity-money-formula-contract-v2.ts",
      "lib/claims/contracts/claim-family-algorithm-matrix-v1.ts",
      "scripts/phase-product-dimensions-shipment-fee-claim-audit-v1-readonly.ts",
    ],
    staging_census,
    model_lanes: {
      actual_cost_basis: {
        sources: REQUIRED_COST_FIELDS,
        never: REQUIRED_COST_FIELDS.forbidden,
      },
      latest_sale_price_context: {
        sources: ["product_prices", "listing price", "amazon_settlements.product_sales"],
        rule: "display-only unless fee_adjusted_sale_estimate model explicitly selected",
      },
      amazon_fee_estimate: {
        components: fee_components_matrix.map((c) => c.component_key),
        api_vs_report: API_VS_REPORT_PRIORITY,
      },
      estimated_amazon_reimbursement: ESTIMATED_REIMBURSEMENT_MODELS,
      observed_reimbursement: {
        sources: [
          "amazon_reimbursements.amount_total",
          "amazon_settlements credits",
          "financial_reference_resolver",
          "amazon_safet_claims (when non-empty)",
        ],
        rule: "Separate lane — never overwrites estimate",
      },
    },
    fee_components_matrix,
    referral_fee_model,
    fba_fulfillment_fee_model,
    storage_fee_model,
    returns_processing_fee_model,
    low_inventory_fee_model,
    inbound_placement_fee_model,
    estimated_reimbursement_models: ESTIMATED_REIMBURSEMENT_MODELS,
    formula_priority_rules: FORMULA_PRIORITY_RULES,
    API_vs_report_priority: API_VS_REPORT_PRIORITY,
    required_product_fields: REQUIRED_PRODUCT_FIELDS,
    required_cost_fields: REQUIRED_COST_FIELDS,
    required_dimension_fields: REQUIRED_DIMENSION_FIELDS,
    fallback_snapshot_rules: FALLBACK_SNAPSHOT_RULES,
    confidence_rules,
    implementation_phases: IMPLEMENTATION_PHASES,
    gaps: [
      "Product Fees API not implemented in repo",
      "product_cost_snapshots table not migrated",
      "amazon_fee_preview empty on main org staging census",
      "amazon_monthly_storage_fees empty on staging",
      "ORBIT buildCogsResolver still falls back to unit_sale_price — must remove in phase 3",
      "Returns/low-inventory/inbound placement reports unsupported in sample zip audit",
    ],
    conditions_for_safe_implement: [
      "Implement read-model as pure functions first — no claim_candidates writes",
      "Product Fees API responses cached with fetched_at — not treated as observed",
      "Fallback schedules stored with effective_date + source_url",
      "Maysam approval for product_cost_snapshots / fee_estimate_snapshots tables if persisting API cache",
    ],
    SAFE_TO_IMPLEMENT_FEE_ESTIMATE_READMODEL,
    NEXT_EXACT_PROMPT: "PHASE-AMAZON-FEE-ESTIMATE-READMODEL-IMPLEMENT-V1",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
