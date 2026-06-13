/**
 * PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V2-GAP-EXPANSION
 * Read-only evaluation of sample-zip / Maysam report gaps — claim vs review vs lifecycle.
 * Extends claim-family-quantity-money-formula-contract-v2.ts without DB writes.
 */

import {
  CLAIM_FAMILY_FORMULA_MATRIX,
  COST_SOURCE_PRIORITY_CHAIN,
  GLOBAL_FORMULA_PRIMITIVES,
  PRODUCT_LINKAGE_JOIN,
  SALE_PRICE_RULE,
  type ClaimFamilyFormulaEntry,
  type ClaimFamilyFormulaKey,
  type JoinKeySpec,
} from "./claim-family-quantity-money-formula-contract-v2";

/** Classification for gap families — Maysam decision framework. */
export type GapFamilyClassification =
  | "claim_family"
  | "review_signal_only"
  | "lifecycle_only"
  | "claim_family_when_source_available";

export type SourceAvailability =
  | "live_table"
  | "live_importer_file"
  | "planned_sp_api"
  | "unsupported_file"
  | "empty_connector"
  | "lifecycle_derived";

export type GapFamilyEvaluation = {
  evaluation_key: string;
  display_name: string;
  classification: GapFamilyClassification;
  rationale: string;
  maps_to_family_key: string;
  v1_status: "missing" | "partial" | "combined_umbrella" | "present";
  source_table_file_api: string[];
  sample_zip_file: string | null;
  source_availability: SourceAvailability;
  availability_note: string;
  quantity_formula: string;
  amount_formula: string;
  estimated_amazon_reimbursement_or_fee_delta: string;
  observed_amount_formula: string;
  product_linkage_requirement: string;
  cost_requirement: string;
  dimension_category_requirement: string | null;
  evidence_requirements: string[];
  confidence_high: string;
  confidence_low: string;
  implementation_priority: "P0" | "P1" | "P2" | "P3" | "deferred";
};

export const V1_FAMILY_COUNT = 23;
export const V2_BASE_FAMILY_COUNT = 27;
export const V2_GAP_ADDED_COUNT = 7;
export const V2_FAMILY_COUNT = V2_BASE_FAMILY_COUNT + V2_GAP_ADDED_COUNT;

export const ADDED_OR_RECLASSIFIED_FAMILIES = {
  added_as_separate_claim_families: [
    "low_inventory_fee_issue",
    "returns_processing_fee_issue",
    "inbound_placement_fee_issue",
    "fba_grade_and_resell_anomaly",
    "replacement_mismatch_without_reimbursement",
  ],
  added_as_review_signals: [
    "reserved_inventory_stuck_signal",
    "available_fba_discrepancy",
    "stranded_inventory_signal",
    "expired_inventory_action_signal",
    "catalog_listing_fee_category_mismatch",
  ],
  reclassified_from_v1_umbrella: {
    from: "stranded_expired_review_signal (V2 combined)",
    to: ["stranded_inventory_signal", "expired_inventory_action_signal"],
    keep_umbrella_for: "lifecycle dashboard grouping only — not auto-claim",
  },
  renamed_aliases: {
    returns_processing_fee_issue: "returns_processing_fee_overcharge (display alias)",
  },
  lifecycle_only_derived: [
    "available_fba (amazon_manage_fba_inventory snapshot)",
    "reserved_fba (amazon_reserved_inventory snapshot)",
    "sent_to_amazon / received_by_amazon (inbound performance grain)",
  ],
} as const;

export const CLAIM_VS_REVIEW_SIGNAL_DECISIONS: Record<string, GapFamilyClassification> = {
  low_inventory_level_fee_issue: "claim_family_when_source_available",
  returns_processing_fee_overcharge: "claim_family_when_source_available",
  inbound_placement_fee_issue: "claim_family_when_source_available",
  fba_grade_and_resell_anomaly: "claim_family_when_source_available",
  replacement_without_reimbursement: "claim_family_when_source_available",
  reserved_inventory_stuck_signal: "review_signal_only",
  available_fba_discrepancy: "review_signal_only",
  stranded_inventory_signal: "review_signal_only",
  expired_inventory_action_signal: "review_signal_only",
  catalog_listing_fee_category_mismatch: "review_signal_only",
};

const feeMoneyGap = (deltaLabel: string) => ({
  actual_cost_basis: "NULL — fee family",
  estimated_amazon_reimbursement: deltaLabel,
  observed_reimbursement: "settlement fee credits OR report posted fee",
  reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
  fee_overcharge_gap: "charged_fee - expected_fee",
  storage_overcharge_gap: null as string | null,
  fee_deductions: "per fee component line",
  cost_source_priority: ["fee_schedule", "report row"],
  sale_price_usage_rule: SALE_PRICE_RULE,
  source_confidence: "high when report imported + linkage",
  actual_loss: deltaLabel,
});

function signalQty(displayField: string, sourceTables: string[]) {
  return {
    source_tables: sourceTables,
    required_identifiers: ["fnsku", "asin"],
    join_keys: [PRODUCT_LINKAGE_JOIN] as JoinKeySpec[],
    quantity_fields: [displayField],
    source_priority: ["1. report snapshot when available", "2. ledger hint"],
    conflict_handling: "Never auto-candidate from signal alone",
    exact_formula: "claim_quantity = NULL; display_qty from source",
    claim_quantity: "NULL",
    confidence: {
      high: "Report + linkage",
      medium: "Snapshot only",
      low: "No import",
    },
  };
}

/** Maysam gap evaluation — 10 requested families + zip context. */
export const GAP_FAMILY_EVALUATIONS: readonly GapFamilyEvaluation[] = [
  {
    evaluation_key: "low_inventory_level_fee_issue",
    display_name: "Low inventory level fee issue",
    classification: "claim_family_when_source_available",
    rationale: "Distinct Amazon fee type; separate from generic FBA fee overcharge",
    maps_to_family_key: "low_inventory_fee_issue",
    v1_status: "missing",
    source_table_file_api: ["planned: low_inventory_fee_report", "amazon_manage_fba_inventory", "amazon_settlements"],
    sample_zip_file: "Low-Inventory-Level Fee Report*.csv",
    source_availability: "unsupported_file",
    availability_note: "Sample zip UNKNOWN importer; manage_fba live for threshold context",
    quantity_formula: "claim_quantity = 1 per (fnsku, fee_month)",
    amount_formula: "fee_overcharge_gap = charged_low_inventory_fee - expected_fee",
    estimated_amazon_reimbursement_or_fee_delta: "fee_overcharge_gap",
    observed_amount_formula: "settlement low-inventory fee lines",
    product_linkage_requirement: "required_before_trusted_money",
    cost_requirement: "NULL — fee delta only",
    dimension_category_requirement: "inventory threshold from manage_fba_inventory",
    evidence_requirements: ["Low-Inventory-Level Fee report", "manage_fba snapshot"],
    confidence_high: "Fee report + manage_fba + linkage",
    confidence_low: "No fee report importer",
    implementation_priority: "P2",
  },
  {
    evaluation_key: "returns_processing_fee_overcharge",
    display_name: "Returns processing fee overcharge",
    classification: "claim_family_when_source_available",
    rationale: "FBA returns processing fee dispute — not customer_return_not_reimbursed inventory lane",
    maps_to_family_key: "returns_processing_fee_issue",
    v1_status: "missing",
    source_table_file_api: ["planned: returns_processing_fee_report", "amazon_returns", "amazon_settlements"],
    sample_zip_file: "Returns Processing Fee*.csv",
    source_availability: "unsupported_file",
    availability_note: "Sample zip audit: UNKNOWN importer",
    quantity_formula: "claim_quantity = 1 per disputed fee line",
    amount_formula: "fee_overcharge_gap = charged - expected",
    estimated_amazon_reimbursement_or_fee_delta: "fee_overcharge_gap",
    observed_amount_formula: "settlement returns processing credits",
    product_linkage_requirement: "required_before_trusted_money",
    cost_requirement: "NULL",
    dimension_category_requirement: null,
    evidence_requirements: ["Returns Processing Fee report", "amazon_returns return_id"],
    confidence_high: "Report + return match",
    confidence_low: "Unsupported file",
    implementation_priority: "P2",
  },
  {
    evaluation_key: "inbound_placement_fee_issue",
    display_name: "Inbound placement fee issue",
    classification: "claim_family_when_source_available",
    rationale: "Distinct placement service fee — not inbound shortage qty",
    maps_to_family_key: "inbound_placement_fee_issue",
    v1_status: "missing",
    source_table_file_api: ["planned: inbound_placement_fees", "amazon_inbound_performance", "amazon_settlements"],
    sample_zip_file: "Inbound Placement Service Fees*.csv",
    source_availability: "unsupported_file",
    availability_note: "UNKNOWN importer; inbound_performance live",
    quantity_formula: "claim_quantity = 1 per placement fee line",
    amount_formula: "fee_overcharge_gap",
    estimated_amazon_reimbursement_or_fee_delta: "fee_overcharge_gap",
    observed_amount_formula: "settlement placement lines",
    product_linkage_requirement: "required_before_trusted_money",
    cost_requirement: "NULL",
    dimension_category_requirement: "placement option",
    evidence_requirements: ["Placement fee report", "fba_shipment_id"],
    confidence_high: "Report + shipment",
    confidence_low: "No importer",
    implementation_priority: "P2",
  },
  {
    evaluation_key: "fba_grade_and_resell_anomaly",
    display_name: "FBA Grade and Resell reimbursement/fee anomaly",
    classification: "claim_family_when_source_available",
    rationale: "Distinct grade/resell reimbursement + fee — not generic return/disposal",
    maps_to_family_key: "fba_grade_and_resell_anomaly",
    v1_status: "missing",
    source_table_file_api: ["planned: amazon_grade_and_resell", "amazon_reimbursements", "amazon_settlements"],
    sample_zip_file: "FBA Grade and Resell*.csv",
    source_availability: "planned_sp_api",
    availability_note: "FBA_GRADE_AND_RESELL registry later",
    quantity_formula: "claim_quantity = COALESCE(graded_units, 1)",
    amount_formula: "reimbursement_gap OR fee_overcharge_gap",
    estimated_amazon_reimbursement_or_fee_delta: "expected_recovery - observed",
    observed_amount_formula: "reimbursements + settlement",
    product_linkage_requirement: "required_before_trusted_money",
    cost_requirement: "COGS when inventory loss",
    dimension_category_requirement: "grade tier",
    evidence_requirements: ["Grade and Resell report"],
    confidence_high: "Report + reimbursement",
    confidence_low: "No importer",
    implementation_priority: "P3",
  },
  {
    evaluation_key: "replacement_mismatch_without_reimbursement",
    display_name: "Replacement without reimbursement / mismatch",
    classification: "claim_family_when_source_available",
    rationale: "Replacements report — distinct from customer return not reimbursed",
    maps_to_family_key: "replacement_mismatch_without_reimbursement",
    v1_status: "missing",
    source_table_file_api: ["planned: amazon_replacements", "amazon_reimbursements", "amazon_settlements"],
    sample_zip_file: "Replacements*.csv",
    source_availability: "planned_sp_api",
    availability_note: "REPLACEMENTS registry later",
    quantity_formula: "claim_quantity = GREATEST(0, replacement_qty - reimbursed_qty)",
    amount_formula: "actual_loss = qty * COGS; reimbursement_gap",
    estimated_amazon_reimbursement_or_fee_delta: "qty * actual_cost_basis",
    observed_amount_formula: "reimbursements for order keys",
    product_linkage_requirement: "required_before_trusted_money",
    cost_requirement: "COGS chain",
    dimension_category_requirement: null,
    evidence_requirements: ["Replacements report", "original order_id"],
    confidence_high: "Replacement + anti-reimbursement",
    confidence_low: "No importer",
    implementation_priority: "P2",
  },
  {
    evaluation_key: "reserved_inventory_stuck_signal",
    display_name: "Reserved inventory stuck signal",
    classification: "review_signal_only",
    rationale: "Reserved snapshot is operational review — not auto-claim without ledger proof",
    maps_to_family_key: "reserved_inventory_stuck_signal",
    v1_status: "partial",
    source_table_file_api: ["amazon_reserved_inventory", "amazon_manage_fba_inventory", "amazon_inventory_ledger"],
    sample_zip_file: "Reserved Inventory*.csv",
    source_availability: "live_importer_file",
    availability_note: "amazon_reserved_inventory live; SP-API worker planned",
    quantity_formula: "claim_quantity = NULL; display reserved_qty where age > threshold",
    amount_formula: "NULL at signal",
    estimated_amazon_reimbursement_or_fee_delta: "NULL",
    observed_amount_formula: "N/A",
    product_linkage_requirement: "recommended",
    cost_requirement: "unavailable",
    dimension_category_requirement: null,
    evidence_requirements: ["Reserved snapshot"],
    confidence_high: "Reserved + linkage",
    confidence_low: "Stale snapshot",
    implementation_priority: "P2",
  },
  {
    evaluation_key: "available_fba_discrepancy",
    display_name: "Available FBA discrepancy",
    classification: "review_signal_only",
    rationale: "manage_fba vs ledger available mismatch — lifecycle until ledger confirms loss",
    maps_to_family_key: "available_fba_discrepancy",
    v1_status: "partial",
    source_table_file_api: ["amazon_manage_fba_inventory", "amazon_inventory_ledger", "amazon_reserved_inventory"],
    sample_zip_file: "Manage FBA Inventory*.csv",
    source_availability: "live_table",
    availability_note: "amazon_manage_fba_inventory live",
    quantity_formula: "claim_quantity = NULL; display ABS(manage_fba - ledger)",
    amount_formula: "NULL until classified",
    estimated_amazon_reimbursement_or_fee_delta: "NULL",
    observed_amount_formula: "N/A",
    product_linkage_requirement: "recommended",
    cost_requirement: "unavailable",
    dimension_category_requirement: null,
    evidence_requirements: ["manage_fba + ledger same-day"],
    confidence_high: "Same-day snapshot + ledger",
    confidence_low: "Stale >45d",
    implementation_priority: "P2",
  },
  {
    evaluation_key: "stranded_inventory_signal",
    display_name: "Stranded inventory signal",
    classification: "review_signal_only",
    rationale: "Listing fix workflow — never auto-claim from stranded alone",
    maps_to_family_key: "stranded_inventory_signal",
    v1_status: "combined_umbrella",
    source_table_file_api: ["planned: amazon_stranded_inventory", "GET_STRANDED_INVENTORY_UI_DATA"],
    sample_zip_file: "Stranded Inventory (expected later)",
    source_availability: "planned_sp_api",
    availability_note: "No table; schema approval pending",
    quantity_formula: "claim_quantity = NULL; display stranded_units",
    amount_formula: "NULL",
    estimated_amazon_reimbursement_or_fee_delta: "NULL",
    observed_amount_formula: "N/A",
    product_linkage_requirement: "recommended",
    cost_requirement: "unavailable",
    dimension_category_requirement: "stranded_reason",
    evidence_requirements: ["Stranded report when wired"],
    confidence_high: "Stranded + linkage",
    confidence_low: "Table missing",
    implementation_priority: "P2",
  },
  {
    evaluation_key: "expired_inventory_action_signal",
    display_name: "Expired / aged inventory action signal",
    classification: "review_signal_only",
    rationale: "Aged inventory → removal/disposal review; may promote to disposed family",
    maps_to_family_key: "expired_inventory_action_signal",
    v1_status: "combined_umbrella",
    source_table_file_api: ["amazon_inventory_ledger", "amazon_manage_fba_inventory"],
    sample_zip_file: null,
    source_availability: "lifecycle_derived",
    availability_note: "Lifecycle expired state; no dedicated zip file",
    quantity_formula: "claim_quantity = NULL; display aged_units",
    amount_formula: "NULL",
    estimated_amazon_reimbursement_or_fee_delta: "NULL",
    observed_amount_formula: "N/A",
    product_linkage_requirement: "recommended",
    cost_requirement: "unavailable",
    dimension_category_requirement: "FEFO/expiry policy",
    evidence_requirements: ["Ledger expired event"],
    confidence_high: "Ledger + linkage",
    confidence_low: "Summary ledger",
    implementation_priority: "P3",
  },
  {
    evaluation_key: "catalog_listing_fee_category_mismatch",
    display_name: "Catalog/listing fee category mismatch",
    classification: "review_signal_only",
    rationale: "Open listings category vs referral fee tier — review before claim",
    maps_to_family_key: "catalog_listing_fee_category_mismatch",
    v1_status: "missing",
    source_table_file_api: ["Open Listings Report Lite", "amazon_fee_preview", "amazon_settlements"],
    sample_zip_file: "Open Listings Report Lite*.csv",
    source_availability: "live_importer_file",
    availability_note: "ALL_LISTINGS heuristic; fee_preview live",
    quantity_formula: "claim_quantity = NULL; display 1 per SKU category dispute for review",
    amount_formula: "NULL at signal; fee delta shown for operator review only",
    estimated_amazon_reimbursement_or_fee_delta: "fee_overcharge_gap",
    observed_amount_formula: "settlement referral lines",
    product_linkage_requirement: "required_before_trusted_money",
    cost_requirement: "NULL",
    dimension_category_requirement: "browse node / category",
    evidence_requirements: ["Open listings", "fee_preview"],
    confidence_high: "Listings + fee_preview",
    confidence_low: "Category map incomplete",
    implementation_priority: "P3",
  },
];

/** Gap expansion formula entries — appended to V2 base (34 total). */
export const GAP_EXPANSION_FORMULA_ENTRIES: readonly ClaimFamilyFormulaEntry[] = [
  {
    family_key: "fba_grade_and_resell_anomaly" as ClaimFamilyFormulaKey,
    display_name: "FBA Grade and Resell anomaly",
    quantity: {
      ...signalQty("graded_units", ["planned: amazon_grade_and_resell", "amazon_reimbursements"]),
      exact_formula: "claim_quantity = COALESCE(graded_units,1) WHEN reimbursable",
      claim_quantity: "COALESCE(graded_units, 1)",
    },
    money: { ...feeMoneyGap("expected_grade_resell_recovery - observed"), actual_cost_basis: "COGS when inventory loss" },
    evidence: {
      trid_edges_required: ["product_link", "claim_to_reimbursement"],
      required_report_rows: ["FBA Grade and Resell"],
      required_files_images: [],
      deadline_window: "grade_event + claim_window",
      claim_readiness_rules: ["report imported"],
    },
    claim_ready_rules: ["await importer"],
    review_signal_rules: ["no table"],
    exclusion_rules: ["authorized disposal"],
    current_status: "gap",
    missing_blocker: "No grade_and_resell importer",
  },
  {
    family_key: "replacement_mismatch_without_reimbursement" as ClaimFamilyFormulaKey,
    display_name: "Replacement mismatch",
    quantity: {
      source_tables: ["planned: amazon_replacements", "amazon_reimbursements"],
      required_identifiers: ["original_order_id", "replacement_order_id", "fnsku"],
      join_keys: [PRODUCT_LINKAGE_JOIN],
      quantity_fields: ["replacement_quantity"],
      source_priority: ["replacements report", "anti reimbursements"],
      conflict_handling: "partial → review",
      exact_formula: "GREATEST(0, replacement_qty - reimbursed_qty)",
      claim_quantity: "GREATEST(0, replacement_qty - reimbursed_qty)",
      confidence: { high: "anti-reimbursement", medium: "report", low: "no importer" },
    },
    money: {
      actual_cost_basis: "COGS chain",
      estimated_amazon_reimbursement: "claim_quantity * actual_cost_basis",
      observed_reimbursement: "SUM(reimbursements)",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: [...COST_SOURCE_PRIORITY_CHAIN],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "money_high with COGS",
      actual_loss: GLOBAL_FORMULA_PRIMITIVES.actual_loss,
    },
    evidence: {
      trid_edges_required: ["order_reference", "product_link"],
      required_report_rows: ["Replacements"],
      required_files_images: [],
      deadline_window: "replacement_ship + claim_window",
      claim_readiness_rules: ["grace elapsed"],
    },
    claim_ready_rules: ["NOT built"],
    review_signal_rules: ["partial replacement"],
    exclusion_rules: ["fully reimbursed"],
    current_status: "gap",
    missing_blocker: "REPLACEMENTS importer later",
  },
  {
    family_key: "reserved_inventory_stuck_signal" as ClaimFamilyFormulaKey,
    display_name: "Reserved inventory stuck signal",
    quantity: signalQty("reserved_qty", ["amazon_reserved_inventory", "amazon_manage_fba_inventory"]),
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "NULL",
      observed_reimbursement: "NULL",
      reimbursement_gap: "NULL",
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: [],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "unavailable",
      actual_loss: "NULL",
    },
    evidence: {
      trid_edges_required: ["product_link"],
      required_report_rows: ["reserved snapshot"],
      required_files_images: [],
      deadline_window: "N/A",
      claim_readiness_rules: ["NEVER auto claim"],
    },
    claim_ready_rules: ["EXCLUDE"],
    review_signal_rules: ["ALWAYS"],
    exclusion_rules: ["auto money"],
    current_status: "partial",
    missing_blocker: "stuck age policy not configured",
  },
  {
    family_key: "available_fba_discrepancy" as ClaimFamilyFormulaKey,
    display_name: "Available FBA discrepancy",
    quantity: signalQty("discrepancy_units", ["amazon_manage_fba_inventory", "amazon_inventory_ledger"]),
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "NULL",
      observed_reimbursement: "NULL",
      reimbursement_gap: "NULL",
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: [],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "unavailable",
      actual_loss: "NULL",
    },
    evidence: {
      trid_edges_required: ["product_link", "ledger_reference"],
      required_report_rows: ["manage_fba + ledger"],
      required_files_images: [],
      deadline_window: "N/A",
      claim_readiness_rules: ["promote after ledger"],
    },
    claim_ready_rules: ["EXCLUDE"],
    review_signal_rules: ["ALWAYS"],
    exclusion_rules: ["snapshot-only claim"],
    current_status: "partial",
    missing_blocker: "no discrepancy classifier",
  },
  {
    family_key: "stranded_inventory_signal" as ClaimFamilyFormulaKey,
    display_name: "Stranded inventory signal",
    quantity: signalQty("stranded_units", ["planned: amazon_stranded_inventory"]),
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "NULL",
      observed_reimbursement: "NULL",
      reimbursement_gap: "NULL",
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: [],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "unavailable",
      actual_loss: "NULL",
    },
    evidence: {
      trid_edges_required: ["product_link"],
      required_report_rows: ["stranded report"],
      required_files_images: [],
      deadline_window: "N/A",
      claim_readiness_rules: ["listing fix only"],
    },
    claim_ready_rules: ["EXCLUDE"],
    review_signal_rules: ["ALWAYS"],
    exclusion_rules: ["auto claim"],
    current_status: "gap",
    missing_blocker: "no stranded table",
  },
  {
    family_key: "expired_inventory_action_signal" as ClaimFamilyFormulaKey,
    display_name: "Expired inventory action signal",
    quantity: signalQty("aged_units", ["amazon_inventory_ledger", "amazon_manage_fba_inventory"]),
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "NULL",
      observed_reimbursement: "NULL",
      reimbursement_gap: "NULL",
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: [],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "unavailable",
      actual_loss: "NULL",
    },
    evidence: {
      trid_edges_required: ["product_link", "ledger_reference"],
      required_report_rows: ["ledger expired"],
      required_files_images: [],
      deadline_window: "N/A",
      claim_readiness_rules: ["NEVER auto from aged alone"],
    },
    claim_ready_rules: ["EXCLUDE"],
    review_signal_rules: ["ALWAYS"],
    exclusion_rules: ["auto money"],
    current_status: "partial",
    missing_blocker: "FEFO policy not wired",
  },
  {
    family_key: "catalog_listing_fee_category_mismatch" as ClaimFamilyFormulaKey,
    display_name: "Catalog/listing fee category mismatch",
    quantity: signalQty("dispute_count", ["Open Listings", "amazon_fee_preview", "amazon_settlements"]),
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "NULL",
      observed_reimbursement: "NULL",
      reimbursement_gap: "NULL",
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "display: referral_charged - referral_expected",
      cost_source_priority: [],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "unavailable until verified",
      actual_loss: "NULL",
    },
    evidence: {
      trid_edges_required: ["product_link", "claim_to_settlement"],
      required_report_rows: ["Open Listings", "fee_preview"],
      required_files_images: ["category proof if disputed"],
      deadline_window: "fee_charge + dispute_days",
      claim_readiness_rules: ["promote after category verified"],
    },
    claim_ready_rules: ["EXCLUDE"],
    review_signal_rules: ["ALWAYS"],
    exclusion_rules: ["auto claim from listings alone"],
    current_status: "gap",
    missing_blocker: "category-fee mapping missing",
  },
];

export const CLAIM_FAMILY_FORMULA_MATRIX_V2_FULL: readonly ClaimFamilyFormulaEntry[] = [
  ...CLAIM_FAMILY_FORMULA_MATRIX,
  ...GAP_EXPANSION_FORMULA_ENTRIES,
];

export const FORMULA_BY_NEW_FAMILY = Object.fromEntries(
  [...GAP_EXPANSION_FORMULA_ENTRIES, ...CLAIM_FAMILY_FORMULA_MATRIX.filter((e) =>
    ["low_inventory_fee_issue", "returns_processing_fee_issue", "inbound_placement_fee_issue"].includes(e.family_key),
  )].map((e) => [
    e.family_key,
    {
      claim_quantity: e.quantity.claim_quantity,
      actual_loss: e.money.actual_loss,
      estimated_amazon_reimbursement: e.money.estimated_amazon_reimbursement,
      observed_reimbursement: e.money.observed_reimbursement,
      reimbursement_gap: e.money.reimbursement_gap,
      fee_overcharge_gap: e.money.fee_overcharge_gap,
    },
  ]),
);

export const REQUIRED_SOURCES_GAP = Object.fromEntries(
  GAP_FAMILY_EVALUATIONS.map((e) => [e.evaluation_key, e.source_table_file_api]),
);

export const SOURCE_AVAILABILITY_GAP = Object.fromEntries(
  GAP_FAMILY_EVALUATIONS.map((e) => [
    e.evaluation_key,
    { status: e.source_availability, note: e.availability_note, sample_zip: e.sample_zip_file },
  ]),
);

export const IMPLEMENTATION_PRIORITY_GAP = [
  "P0: customer_return_not_reimbursed (unchanged)",
  "P1: fee report importers — low_inventory, returns_processing, inbound_placement",
  "P1: replacement_mismatch after REPLACEMENTS importer",
  "P2: reserved_stuck + available_fba + stranded signals (review UI)",
  "P3: grade_resell + catalog_listing + expired_action",
] as const;

export const FIRST_SAFE_NEW_FAMILY_TO_IMPLEMENT = "low_inventory_fee_issue" as const;

export const SAFE_TO_IMPLEMENT_V2_READMODEL = "yes" as const;

export const NEXT_PROMPT_GAP = `PHASE-CLAIM-FAMILY-CALCULATION-READMODEL-IMPLEMENT-V1

Expose CLAIM_FAMILY_FORMULA_MATRIX_V2_FULL (34 families) + GAP_FAMILY_EVALUATIONS via calculation-contract API.

Then PHASE-FEE-REPORT-IMPORTER-SCAFFOLD-V1 for Low-Inventory, Returns Processing Fee, Inbound Placement file importers.` as const;
