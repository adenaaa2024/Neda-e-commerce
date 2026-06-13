/**
 * PHASE-CLAIM-FAMILY-QUANTITY-AND-MONEY-FORMULA-CONTRACT-V2
 * Exact read-only calculation contract — joins, source priority, amount formulas, blockers.
 * No DB writes. No generator implementation.
 */

import { EXPECTED_PACKAGE_SOURCE_PRIORITY_RULES } from "@/lib/expected-packages-conflict-status";

export type ClaimFamilyFormulaKey =
  | "physical_return_scanner_issue"
  | "customer_return_not_reimbursed"
  | "refund_without_return"
  | "wrong_item_returned"
  | "empty_box_return"
  | "customer_damaged_return"
  | "removal_order_discrepancy"
  | "removal_shipment_missing"
  | "removal_damaged_during_removal"
  | "disposed_without_reimbursement"
  | "warehouse_lost_inventory"
  | "warehouse_damaged_inventory"
  | "inventory_adjustment_error"
  | "inbound_shipment_shortage"
  | "inbound_receiving_miscount"
  | "missing_reimbursement"
  | "partial_incorrect_reimbursement"
  | "settlement_refund_anomaly"
  | "safet_followup"
  | "fba_fee_overcharge"
  | "monthly_storage_fee_overcharge"
  | "dimension_weight_fee_issue"
  | "low_inventory_fee_issue"
  | "returns_processing_fee_issue"
  | "inbound_placement_fee_issue"
  | "stranded_expired_review_signal"
  | "orbit_fra_fight_list";

export type JoinKeySpec = {
  left_table: string;
  left_field: string;
  right_table: string;
  right_field: string;
  join_type: "inner" | "left" | "anti" | "exact_identifier";
  notes?: string;
};

export type QuantityFormulaContract = {
  source_tables: string[];
  required_identifiers: string[];
  join_keys: JoinKeySpec[];
  quantity_fields: string[];
  source_priority: string[];
  conflict_handling: string;
  exact_formula: string;
  claim_quantity: string;
  confidence: { high: string; medium: string; low: string };
};

export type MoneyFormulaContract = {
  actual_cost_basis: string;
  estimated_amazon_reimbursement: string;
  observed_reimbursement: string;
  reimbursement_gap: string;
  fee_overcharge_gap: string | null;
  storage_overcharge_gap: string | null;
  fee_deductions: string;
  cost_source_priority: string[];
  sale_price_usage_rule: string;
  source_confidence: string;
  actual_loss: string;
};

export type EvidenceFormulaContract = {
  trid_edges_required: string[];
  required_report_rows: string[];
  required_files_images: string[];
  deadline_window: string;
  claim_readiness_rules: string[];
};

export type ClaimFamilyFormulaEntry = {
  family_key: ClaimFamilyFormulaKey;
  display_name: string;
  quantity: QuantityFormulaContract;
  money: MoneyFormulaContract;
  evidence: EvidenceFormulaContract;
  claim_ready_rules: string[];
  review_signal_rules: string[];
  exclusion_rules: string[];
  current_status: "live" | "partial" | "gap" | "review_signal_only";
  missing_blocker: string;
};

/** Global calculation primitives — all families compose these. */
export const GLOBAL_FORMULA_PRIMITIVES = {
  claim_quantity: "Per-family integer >= 0 after clean/disputed filters; NULL when signal-only family",
  actual_loss:
    "actual_loss = CASE WHEN claim_quantity IS NOT NULL AND actual_cost_basis IS NOT NULL THEN claim_quantity * actual_cost_basis ELSE NULL END",
  estimated_amazon_reimbursement:
    "Policy-based estimate of what Amazon may reimburse — NOT guaranteed payout; NULL when inputs unavailable",
  observed_reimbursement:
    "observed_reimbursement = COALESCE(SUM(amazon_reimbursements.amount_total), settlement_credit, safet.total_reimbursement_amount) for matched keys — separate lane",
  reimbursement_gap:
    "reimbursement_gap = CASE WHEN estimated_amazon_reimbursement IS NOT NULL AND observed_reimbursement IS NOT NULL THEN estimated_amazon_reimbursement - observed_reimbursement ELSE NULL END",
  fee_overcharge_gap:
    "fee_overcharge_gap = CASE WHEN charged_fee IS NOT NULL AND expected_fee IS NOT NULL THEN charged_fee - expected_fee ELSE NULL END",
  storage_overcharge_gap:
    "storage_overcharge_gap = CASE WHEN charged_storage_fee IS NOT NULL AND expected_storage_fee IS NOT NULL THEN charged_storage_fee - expected_storage_fee ELSE NULL END",
} as const;

export const COST_SOURCE_PRIORITY_CHAIN = [
  "1. workspace_settings.module_configs.claim_intake.cogs_overrides[sku|fnsku|asin]",
  "2. product_cost_snapshots.unit_cost (SellerSnap feed when wired)",
  "3. product_cost_snapshots manual vendor cost import",
  "4. return_items.estimated_value (operational warehouse estimate — NOT unit_sale_price)",
  "5. NULL (unknown — never 0, never product_prices.sale_price)",
] as const;

export const SALE_PRICE_RULE =
  "product_prices.list_price / sale context ONLY for display; NEVER actual_cost_basis; NEVER estimated_amazon_reimbursement substitute";

export const PRODUCT_LINKAGE_JOIN: JoinKeySpec = {
  left_table: "product_identifier_map",
  left_field: "identifier_value",
  right_table: "source_row",
  right_field: "fnsku|asin|sku",
  join_type: "exact_identifier",
  notes: "organization_id scoped; no title match; no auto-create",
};

export const CLEAN_EP_FILTER =
  "expected_packages.build_status IN ('matched','expected','resolved','complete')";

export const DISPUTED_EP_EXCLUDE =
  "expected_packages.build_status IN ('shipment_overflow_conflict','detail_remainder','source_conflict','stale_partial_snapshot','duplicate_source_conflict') OR unknown → review_signal_only";

export const CLAIM_CALCULATION_HARD_RULES = [
  "Never use sale price as COGS.",
  "Unknown cost is NULL, not zero.",
  "Empty source is unavailable (NULL), not zero.",
  "Disputed/source-conflict rows do not become claim-ready.",
  "observed_reimbursement is separate from estimated_amazon_reimbursement.",
  "estimated_amazon_reimbursement is an estimate, not guaranteed payout.",
  "Product linkage required before Product Story and trusted money.",
  "No title-only matching.",
  "No product auto-create from scanner/OCR/raw report/title.",
  "legacy_seed / quarantined claim_candidates are never source of truth.",
] as const;

export const CONFIDENCE_RULES_V2 = {
  quantity_high:
    "Exact identifier + single authoritative source row + clean build_status + join cardinality 1:1",
  quantity_medium: "Identifier match + one source; minor staleness < 45d",
  quantity_low: "Conflicting sources, disputed EP, superseded removal detail, or missing join target",
  money_high: "actual_cost_basis resolved from overrides or cost_snapshots + quantity high",
  money_medium: "actual_cost_basis from return_items.estimated_value OR report_amount estimate",
  money_low: "actual_cost_basis NULL — money fields unavailable except observed lane",
  trusted_money_gate: "money_high OR (money_medium AND product_linkage.is_resolved)",
} as const;

export const CLAIM_READY_RULES_GLOBAL = [
  "claim_quantity > 0",
  "NOT disputed_row",
  "NOT legacy_seed / quarantined",
  "source_kind enabled in intake policy",
  "event_date within claim_window AND NOT expired",
  "product_linkage resolved when family requires trusted money",
  "required TRID anchor edges present OR defer_until_evidence",
] as const;

export const REVIEW_SIGNAL_RULES_GLOBAL = [
  "disputed expected_packages row",
  "removal detail superseded by newer upload (removal-source-supersession)",
  "shipment vs detail quantity disagreement",
  "product linkage unresolved but identifier present",
  "fee/dimension spine incomplete",
  "stranded/expired — signal only",
  "empty connector table (SAFE-T, fee reports) → unavailable not zero",
] as const;

export const EXCLUSION_RULES_GLOBAL = [
  "return_items.test_seed / voided packages",
  "claim_quantity = 0 after clean filter",
  "duplicate dedupe_key with status filed|reimbursed",
  "source disabled by policy",
  "pre_cutoff event_date",
  "non-reimbursable disposition codes",
] as const;

export const REQUIRED_API_REPORTS_BY_FAMILY: Record<ClaimFamilyFormulaKey, string[]> = {
  physical_return_scanner_issue: [],
  customer_return_not_reimbursed: ["GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", "GET_LEDGER_DETAIL_VIEW_DATA"],
  refund_without_return: ["GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE", "GET_LEDGER_DETAIL_VIEW_DATA"],
  wrong_item_returned: [],
  empty_box_return: [],
  customer_damaged_return: ["GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA"],
  removal_order_discrepancy: ["GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA", "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA"],
  removal_shipment_missing: ["GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA"],
  removal_damaged_during_removal: ["GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA", "GET_LEDGER_DETAIL_VIEW_DATA"],
  disposed_without_reimbursement: ["GET_LEDGER_DETAIL_VIEW_DATA", "GET_FBA_REIMBURSEMENTS_DATA"],
  warehouse_lost_inventory: ["GET_LEDGER_DETAIL_VIEW_DATA"],
  warehouse_damaged_inventory: ["GET_LEDGER_DETAIL_VIEW_DATA"],
  inventory_adjustment_error: ["GET_LEDGER_DETAIL_VIEW_DATA"],
  inbound_shipment_shortage: ["GET_FBA_INBOUND_PERFORMANCE_DATA"],
  inbound_receiving_miscount: ["GET_FBA_INBOUND_PERFORMANCE_DATA"],
  missing_reimbursement: ["GET_FBA_REIMBURSEMENTS_DATA", "GET_LEDGER_DETAIL_VIEW_DATA"],
  partial_incorrect_reimbursement: ["GET_FBA_REIMBURSEMENTS_DATA"],
  settlement_refund_anomaly: ["GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE"],
  safet_followup: ["SAFE-T export / SP-API when available"],
  fba_fee_overcharge: ["GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA"],
  monthly_storage_fee_overcharge: ["GET_FBA_STORAGE_FEE_CHARGES_DATA"],
  dimension_weight_fee_issue: ["GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA"],
  low_inventory_fee_issue: ["Low-Inventory-Level Fee report (file-first)"],
  returns_processing_fee_issue: ["Returns Processing Fee report (file-first)"],
  inbound_placement_fee_issue: ["Inbound Placement Service Fees (file-first)"],
  stranded_expired_review_signal: ["GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT", "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA"],
  orbit_fra_fight_list: ["All 9 ORBIT source reports"],
};

export const REQUIRED_MANUAL_COST_INPUTS = [
  "workspace_settings.module_configs.claim_intake.cogs_overrides",
  "SellerSnap COGS import → product_cost_snapshots (not wired)",
  "Vendor cost sheet → product_cost_snapshots",
  "PC04 measured dimensions for fee recomputation",
  "Operator warehouse estimate on return_items.estimated_value (fallback only)",
] as const;

function moneyCogsFamily(estimateNote: string): MoneyFormulaContract {
  return {
    actual_cost_basis: "COALESCE(cogs_overrides[fnsku|sku|asin], product_cost_snapshots.unit_cost, return_items.estimated_value) — NULL if none",
    estimated_amazon_reimbursement: estimateNote,
    observed_reimbursement:
      "SUM(amazon_reimbursements.amount_total) WHERE join_keys match AND approval_date <= observation_cutoff",
    reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
    fee_overcharge_gap: null,
    storage_overcharge_gap: null,
    fee_deductions: "Amazon referral/FBA fees already netted in reimbursement rows — do not double-deduct unless settlement line explicit",
    cost_source_priority: [...COST_SOURCE_PRIORITY_CHAIN],
    sale_price_usage_rule: SALE_PRICE_RULE,
    source_confidence: "money_high when cost_snapshots hit; else money_medium with estimated_value; else money_low (NULL)",
    actual_loss: GLOBAL_FORMULA_PRIMITIVES.actual_loss,
  };
}

function qtyScanner(physicalEvents: string): QuantityFormulaContract {
  return {
    source_tables: ["return_items", "packages", "expected_packages"],
    required_identifiers: ["return_items.id", "packages.id", "fnsku|asin|sku"],
    join_keys: [
      { left_table: "return_items", left_field: "package_id", right_table: "packages", right_field: "id", join_type: "inner" },
      PRODUCT_LINKAGE_JOIN,
      {
        left_table: "expected_packages",
        left_field: "fnsku+tracking",
        right_table: "packages",
        right_field: "fnsku+tracking_number",
        join_type: "left",
        notes: CLEAN_EP_FILTER,
      },
    ],
    quantity_fields: ["return_items.qty=1 per scan row", "expected_packages.expected_scan_quantity (clean only)"],
    source_priority: ["1. return_items physical scan (authoritative)", `2. expected_packages clean manifest (${EXPECTED_PACKAGE_SOURCE_PRIORITY_RULES.primary_physical_evidence})`],
    conflict_handling: DISPUTED_EP_EXCLUDE,
    exact_formula: `claim_quantity = COUNT(return_items.id) WHERE physical_event IN (${physicalEvents}) AND return_items.deleted_at IS NULL AND NOT test_seed AND packages.deleted_at IS NULL`,
    claim_quantity: `COUNT(*) FILTER (WHERE physical_event IN (${physicalEvents}))`,
    confidence: {
      high: "Closed package + resolved linkage + scan FNSKU match",
      medium: "Scan without full linkage",
      low: "Orphan scan / disputed manifest",
    },
  };
}

/** 27-family exact formula matrix. */
export const CLAIM_FAMILY_FORMULA_MATRIX: readonly ClaimFamilyFormulaEntry[] = [
  {
    family_key: "physical_return_scanner_issue",
    display_name: "Physical return scanner issue",
    quantity: qtyScanner("'damaged','wrong_item','expired','unexpected_item','missing'"),
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis * policy.reimbursement_rate_default (default 1.0 inventory reimbursement)"),
    evidence: {
      trid_edges_required: ["product_link", "shipment_scope|package_id", "source_evidence"],
      required_report_rows: ["return_items row", "packages row"],
      required_files_images: ["Operator condition photos when policy.requires_photos"],
      deadline_window: "event_date = return_items.scanned_at; window = policy.claim_window_days",
      claim_readiness_rules: ["package.status = closed", "physical_event policy-claimable", "NOT test_seed"],
    },
    claim_ready_rules: ["claim_quantity > 0", "package closed", "intake policy allows physical events"],
    review_signal_rules: ["linkage unresolved", "orbit_fra twin pending dedupe"],
    exclusion_rules: ["voided package", "legacy_seed"],
    current_status: "live",
    missing_blocker: "TRID sparse; cost_snapshots empty for many SKUs",
  },
  {
    family_key: "customer_return_not_reimbursed",
    display_name: "Customer return not reimbursed",
    quantity: {
      source_tables: ["amazon_returns", "amazon_inventory_ledger", "amazon_reimbursements", "product_identifier_map"],
      required_identifiers: ["fnsku", "asin", "order_id", "return_id|license_plate_number"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "amazon_returns", left_field: "fnsku+return_date", right_table: "amazon_inventory_ledger", right_field: "fnsku+event_date", join_type: "inner", notes: "ledger reason CustomerReturn" },
        { left_table: "amazon_returns", left_field: "fnsku+order_id+return_date", right_table: "amazon_reimbursements", right_field: "fnsku+order_id+approval_date", join_type: "anti", notes: "no reimbursement within grace_days" },
      ],
      quantity_fields: ["amazon_returns.quantity", "amazon_inventory_ledger.quantity", "amazon_reimbursements.quantity_reimbursed_total"],
      source_priority: ["1. amazon_inventory_ledger detail CustomerReturn", "2. amazon_returns FBA report", "3. anti-join reimbursements"],
      conflict_handling: "Conflicting return file versions → MAX(return_date) wins; older → review_signal",
      exact_formula: "claim_quantity = GREATEST(0, ledger_return_qty - COALESCE(SUM(reimbursements.quantity_reimbursed_total),0)) per return_event_key",
      claim_quantity: "GREATEST(0, ledger_return_qty - reimbursed_qty)",
      confidence: { high: "Ledger + returns + anti-reimbursement + linkage", medium: "Returns only", low: "Summary ledger" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis (standard FBA return reimbursement estimate)"),
    evidence: {
      trid_edges_required: ["product_link", "order_reference", "ledger_reference", "claim_to_reimbursement (absence edge)"],
      required_report_rows: ["amazon_returns", "ledger CustomerReturn line"],
      required_files_images: [],
      deadline_window: "return_date + policy.fba_return_reimbursement_grace_days (default 30)",
      claim_readiness_rules: ["grace elapsed", "reimbursable disposition"],
    },
    claim_ready_rules: ["claim_quantity > 0", "linkage resolved", "grace elapsed"],
    review_signal_rules: ["pending Amazon processing within grace"],
    exclusion_rules: ["non-reimbursable disposition", "already reimbursed"],
    current_status: "gap",
    missing_blocker: "No 7C generator; FBA returns ↔ reimbursement join not implemented",
  },
  {
    family_key: "refund_without_return",
    display_name: "Refund without return",
    quantity: {
      source_tables: ["amazon_settlements", "amazon_transactions", "amazon_inventory_ledger", "product_identifier_map"],
      required_identifiers: ["settlement_id", "order_id", "sku"],
      join_keys: [
        { left_table: "amazon_settlements", left_field: "order_id+sku", right_table: "amazon_inventory_ledger", right_field: "order_id+sku", join_type: "anti", notes: "no CustomerReturn inbound" },
        PRODUCT_LINKAGE_JOIN,
      ],
      quantity_fields: ["settlement.quantity", "settlement.amount"],
      source_priority: ["1. settlement negative refund line", "2. transaction chargeback", "3. anti ledger return"],
      conflict_handling: "Partial multi-line refunds → one candidate per settlement line",
      exact_formula: "claim_quantity = COALESCE(settlement.quantity, 1) per refund_line WHERE amount < 0 AND NOT EXISTS ledger CustomerReturn",
      claim_quantity: "COALESCE(settlement.quantity, 1)",
      confidence: { high: "Settlement + order + anti-return", medium: "Settlement only", low: "Unparsed line" },
    },
    money: {
      ...moneyCogsFamily("estimated_amazon_reimbursement = ABS(settlement.amount) OR claim_quantity * actual_cost_basis"),
      estimated_amazon_reimbursement: "ABS(settlement.amount) when unit qty unknown; else claim_quantity * actual_cost_basis",
    },
    evidence: {
      trid_edges_required: ["claim_to_settlement", "order_reference", "ledger_reference (anti)"],
      required_report_rows: ["amazon_settlements refund line"],
      required_files_images: [],
      deadline_window: "settlement.posted_date + policy.settlement_dispute_days",
      claim_readiness_rules: ["negative amount", "inventory-impacting SKU"],
    },
    claim_ready_rules: ["ABS(amount) > tolerance", "order_id present"],
    review_signal_rules: ["goodwill refund classification uncertain"],
    exclusion_rules: ["non-inventory SKU", "expected fee charge"],
    current_status: "partial",
    missing_blocker: "Explicit without-return family not split from settlement_refund_review",
  },
  {
    family_key: "wrong_item_returned",
    display_name: "Wrong item returned",
    quantity: {
      source_tables: ["return_items", "expected_packages", "product_identifier_map"],
      required_identifiers: ["scanned_fnsku", "expected_fnsku", "package_id"],
      join_keys: [
        { left_table: "return_items", left_field: "fnsku", right_table: "expected_packages", right_field: "fnsku", join_type: "inner", notes: "fnsku mismatch" },
        PRODUCT_LINKAGE_JOIN,
      ],
      quantity_fields: ["return_items count = 1 per event"],
      source_priority: ["1. return_items scan mismatch", "2. expected_packages clean expected line"],
      conflict_handling: DISPUTED_EP_EXCLUDE,
      exact_formula: "claim_quantity = 1 per return_items row WHERE physical_event='wrong_item' AND UPPER(scanned_fnsku) <> UPPER(expected_fnsku)",
      claim_quantity: "1",
      confidence: { high: "Mismatch + closed package", medium: "Operator flag", low: "No expected line" },
    },
    money: {
      actual_cost_basis: "actual_cost_basis_expected_sku AND actual_cost_basis_received_sku — net loss uses expected SKU cost unless policy dual-product",
      estimated_amazon_reimbursement: "claim_quantity * actual_cost_basis_expected_sku",
      observed_reimbursement: "SUM(reimbursements) for wrong-item return if any",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: [...COST_SOURCE_PRIORITY_CHAIN],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "Requires both product linkages for dual-SKU net loss",
      actual_loss: GLOBAL_FORMULA_PRIMITIVES.actual_loss,
    },
    evidence: {
      trid_edges_required: ["product_link×2", "shipment_scope", "source_evidence"],
      required_report_rows: ["return_items wrong_item"],
      required_files_images: ["Label photo both SKUs"],
      deadline_window: "return_items.scanned_at + policy.claim_window_days",
      claim_readiness_rules: ["identifier mismatch proven"],
    },
    claim_ready_rules: ["wrong_item event", "mismatch proven"],
    review_signal_rules: ["disputed expected line"],
    exclusion_rules: ["normalized identifier match"],
    current_status: "partial",
    missing_blocker: "Dual-product cost logic not built",
  },
  {
    family_key: "empty_box_return",
    display_name: "Empty box return",
    quantity: {
      source_tables: ["packages", "return_items", "expected_packages"],
      required_identifiers: ["package_id", "tracking_number", "fnsku"],
      join_keys: [
        { left_table: "packages", left_field: "id", right_table: "return_items", right_field: "package_id", join_type: "left", notes: "zero scans" },
        { left_table: "expected_packages", left_field: "tracking+fnsku", right_table: "packages", right_field: "tracking+fnsku", join_type: "inner", notes: CLEAN_EP_FILTER },
      ],
      quantity_fields: ["expected_packages.expected_scan_quantity (clean)", "packages.actual_item_count"],
      source_priority: ["1. packages.actual_item_count=0 at close", "2. SUM(clean expected_packages.expected_scan_quantity)"],
      conflict_handling: DISPUTED_EP_EXCLUDE,
      exact_formula: "claim_quantity = SUM(expected_scan_quantity) FILTER (clean EP) WHERE packages.actual_item_count=0 AND packages.closed_at IS NOT NULL",
      claim_quantity: "SUM(clean expected_scan_quantity)",
      confidence: { high: "Box close + clean expected", medium: "EP only", low: "Disputed EP" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["shipment_scope", "package_id", "product_link"],
      required_report_rows: ["packages", "clean expected_packages"],
      required_files_images: ["Empty box photo if policy.requires_photos"],
      deadline_window: "packages.closed_at + policy.claim_window_days",
      claim_readiness_rules: ["actual_item_count=0", "expected_clean>0"],
    },
    claim_ready_rules: ["empty_box_received live emit conditions"],
    review_signal_rules: ["disputed EP only"],
    exclusion_rules: ["intentional zero manifest"],
    current_status: "live",
    missing_blocker: "Scheduled generator does not emit empty_box separately",
  },
  {
    family_key: "customer_damaged_return",
    display_name: "Customer damaged return",
    quantity: qtyScanner("'damaged'"),
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis * policy.customer_damage_reimbursement_rate"),
    evidence: {
      trid_edges_required: ["product_link", "ledger_reference", "source_evidence"],
      required_report_rows: ["return_items damaged", "amazon_returns disposition"],
      required_files_images: ["Damage photos"],
      deadline_window: "scanned_at + policy.claim_window_days",
      claim_readiness_rules: ["customer damage disposition NOT warehouse damage"],
    },
    claim_ready_rules: ["physical_event=damaged", "customer disposition"],
    review_signal_rules: ["warehouse vs customer damage ambiguous"],
    exclusion_rules: ["warehouse_damaged_inventory family"],
    current_status: "partial",
    missing_blocker: "Disposition split incomplete",
  },
  {
    family_key: "removal_order_discrepancy",
    display_name: "Removal order discrepancy",
    quantity: {
      source_tables: ["amazon_removals", "amazon_removal_shipments", "expected_packages", "product_identifier_map"],
      required_identifiers: ["removal_order_id", "fnsku", "source_detail_row_id"],
      join_keys: [
        { left_table: "amazon_removals", left_field: "removal_order_id+fnsku", right_table: "amazon_removal_shipments", right_field: "removal_order_id+fnsku", join_type: "inner" },
        { left_table: "amazon_removals", left_field: "id", right_table: "expected_packages", right_field: "source_detail_row_id", join_type: "left", notes: CLEAN_EP_FILTER },
        PRODUCT_LINKAGE_JOIN,
      ],
      quantity_fields: ["amazon_removals.shipped_quantity", "amazon_removal_shipments.shipped_quantity", "expected_packages.expected_scan_quantity"],
      source_priority: [
        "1. amazon_removal_shipments.shipped_quantity (physical shipment evidence)",
        "2. Non-superseded amazon_removals detail (removal-source-supersession)",
        "3. clean expected_packages",
      ],
      conflict_handling: "Superseded partial detail excluded; shipment_overflow_conflict → review_signal",
      exact_formula: "claim_quantity = GREATEST(0, detail_qty_non_superseded - shipment_qty_received) OR GREATEST(0, order_requested - shipped) per policy.removal_discrepancy_mode",
      claim_quantity: "GREATEST(0, clean_detail_total - shipment_total)",
      confidence: { high: "Single detail version + shipment", medium: "API sync", low: "Stale partial detail" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["order_reference", "claim_to_removal", "claim_to_shipment", "product_link"],
      required_report_rows: ["amazon_removals", "amazon_removal_shipments"],
      required_files_images: [],
      deadline_window: "shipment_date + policy.removal_dispute_days",
      claim_readiness_rules: ["clean qty only", "supersession applied"],
    },
    claim_ready_rules: ["removal_missing_units generator filters", "clean EP"],
    review_signal_rules: ["disputed EP", "superseded detail"],
    exclusion_rules: ["qty 0 after supersession"],
    current_status: "live",
    missing_blocker: "Full supersession in generator incomplete",
  },
  {
    family_key: "removal_shipment_missing",
    display_name: "Removal shipment missing",
    quantity: {
      source_tables: ["expected_packages", "packages", "amazon_removal_shipments", "product_identifier_map"],
      required_identifiers: ["tracking_number", "fnsku", "removal_order_id"],
      join_keys: [
        { left_table: "expected_packages", left_field: "tracking_number+fnsku", right_table: "packages", right_field: "tracking_number", join_type: "anti", notes: "tracking not received" },
        { left_table: "expected_packages", left_field: "tracking", right_table: "amazon_removal_shipments", right_field: "tracking_number", join_type: "inner", notes: CLEAN_EP_FILTER },
        PRODUCT_LINKAGE_JOIN,
      ],
      quantity_fields: ["expected_packages.expected_scan_quantity (clean)", "packages.actual_item_count"],
      source_priority: ["1. clean expected_packages", "2. amazon_removal_shipments.shipped_quantity", "3. packages receive proof"],
      conflict_handling: DISPUTED_EP_EXCLUDE,
      exact_formula: "claim_quantity = SUM(clean expected_scan_quantity) WHERE tracking NOT IN packages.received AND days_since(shipment_date) > policy.delayed_not_received_days",
      claim_quantity: "SUM(clean expected_scan_quantity)",
      confidence: { high: "Overdue tracking + clean expected", medium: "Shipment row", low: "Disputed manifest" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["claim_to_shipment", "tracking_number", "shipment_scope", "product_link"],
      required_report_rows: ["expected_packages clean", "amazon_removal_shipments"],
      required_files_images: ["Carrier tracking screenshot if disputed"],
      deadline_window: "shipment_date + delayed_not_received_days",
      claim_readiness_rules: ["tracking not in packages", "clean EP"],
    },
    claim_ready_rules: ["delayed_not_received on clean rows"],
    review_signal_rules: ["disputed overflow"],
    exclusion_rules: ["tracking received"],
    current_status: "live",
    missing_blocker: "None for missing path — damage split is separate family",
  },
  {
    family_key: "removal_damaged_during_removal",
    display_name: "Removal damaged during removal",
    quantity: {
      source_tables: ["return_items", "packages", "expected_packages", "amazon_removal_shipments", "amazon_inventory_ledger"],
      required_identifiers: ["tracking_number", "fnsku", "package_id"],
      join_keys: [
        { left_table: "return_items", left_field: "package_id", right_table: "packages", right_field: "id", join_type: "inner", notes: "physical_event=damaged at removal receive" },
        { left_table: "packages", left_field: "tracking_number", right_table: "amazon_removal_shipments", right_field: "tracking_number", join_type: "inner" },
        PRODUCT_LINKAGE_JOIN,
      ],
      quantity_fields: ["return_items count", "expected_packages.expected_scan_quantity (clean)"],
      source_priority: ["1. return_items damaged scan at receive", "2. ledger damage at removal FC", "3. clean expected short vs damaged"],
      conflict_handling: DISPUTED_EP_EXCLUDE,
      exact_formula: "claim_quantity = COUNT(return_items) WHERE physical_event='damaged' AND removal_context=true AND disposition IN ('removal_damage','carrier_damage')",
      claim_quantity: "COUNT(damaged scans) OR GREATEST(0, clean_expected - good_units_received)",
      confidence: { high: "Scan + shipment + linkage", medium: "Ledger damage code", low: "No scan proof" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["claim_to_shipment", "product_link", "source_evidence", "ledger_reference"],
      required_report_rows: ["removal shipment", "damage scan or ledger"],
      required_files_images: ["Damage photos at receive"],
      deadline_window: "receive_date + policy.claim_window_days",
      claim_readiness_rules: ["removal context proven", "NOT customer return damage"],
    },
    claim_ready_rules: ["damaged at removal receive"],
    review_signal_rules: ["customer vs removal damage ambiguous"],
    exclusion_rules: ["customer_damaged_return"],
    current_status: "gap",
    missing_blocker: "No generator; removal damage disposition taxonomy missing",
  },
  {
    family_key: "disposed_without_reimbursement",
    display_name: "Disposed/destroyed without reimbursement",
    quantity: {
      source_tables: ["amazon_inventory_ledger", "amazon_reimbursements", "product_identifier_map"],
      required_identifiers: ["fnsku", "ledger_reference_id", "reason_code"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "amazon_inventory_ledger", left_field: "reference_id", right_table: "amazon_reimbursements", right_field: "original_reimbursement_id|order_id", join_type: "anti" },
      ],
      quantity_fields: ["amazon_inventory_ledger.quantity"],
      source_priority: ["1. ledger detail Dispose/Destroy", "2. anti reimbursements"],
      conflict_handling: "Summary ledger → review_signal; require detail view",
      exact_formula: "claim_quantity = ABS(ledger.quantity) WHERE reason IN ('Dispose','Destroy') AND NOT EXISTS matching reimbursement",
      claim_quantity: "ABS(ledger.quantity)",
      confidence: { high: "Detail ledger + anti-reimbursement", medium: "Ledger only", low: "Summary ledger" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["ledger_reference", "product_link", "claim_to_reimbursement anti"],
      required_report_rows: ["ledger dispose line"],
      required_files_images: [],
      deadline_window: "ledger.event_date + policy.adjustment_window_days",
      claim_readiness_rules: ["authorized dispose excluded"],
    },
    claim_ready_rules: ["ORBIT destroyed_without_permission hit"],
    review_signal_rules: ["summary ledger only"],
    exclusion_rules: ["authorized dispose"],
    current_status: "partial",
    missing_blocker: "Reimbursement cross-check not in generator",
  },
  {
    family_key: "warehouse_lost_inventory",
    display_name: "Warehouse lost inventory",
    quantity: {
      source_tables: ["amazon_inventory_ledger", "product_identifier_map"],
      required_identifiers: ["fnsku", "ledger_reference_id"],
      join_keys: [PRODUCT_LINKAGE_JOIN],
      quantity_fields: ["amazon_inventory_ledger.quantity"],
      source_priority: ["1. ledger detail reason M/E/lost"],
      conflict_handling: "Summary → review_signal",
      exact_formula: "claim_quantity = ABS(ledger.quantity) WHERE unreconciled_negative AND reason_code IN ('M','E','Lost')",
      claim_quantity: "ABS(unreconciled_negative_qty)",
      confidence: { high: "Detail + linkage", medium: "Detail", low: "Summary" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["ledger_reference", "product_link"],
      required_report_rows: ["GET_LEDGER_DETAIL_VIEW_DATA row"],
      required_files_images: [],
      deadline_window: "ledger.event_date + policy.adjustment_window_days",
      claim_readiness_rules: ["lost reason code"],
    },
    claim_ready_rules: ["inventory_unreconciled_loss OR ORBIT warehouse_lost"],
    review_signal_rules: ["summary ledger"],
    exclusion_rules: ["already reimbursed"],
    current_status: "live",
    missing_blocker: "Detail import gap some stores",
  },
  {
    family_key: "warehouse_damaged_inventory",
    display_name: "Warehouse damaged inventory",
    quantity: {
      source_tables: ["amazon_inventory_ledger", "product_identifier_map"],
      required_identifiers: ["fnsku", "reason_code D"],
      join_keys: [PRODUCT_LINKAGE_JOIN],
      quantity_fields: ["amazon_inventory_ledger.quantity"],
      source_priority: ["1. ledger warehouse damage codes"],
      conflict_handling: "Customer return damage → exclude",
      exact_formula: "claim_quantity = ABS(ledger.quantity) WHERE reason_code='D' AND NOT customer_return_path",
      claim_quantity: "ABS(ledger.quantity)",
      confidence: { high: "Detail ledger", medium: "Summary", low: "Ambiguous D code" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["ledger_reference", "product_link"],
      required_report_rows: ["ledger damage line"],
      required_files_images: [],
      deadline_window: "ledger.event_date + policy.adjustment_window_days",
      claim_readiness_rules: ["warehouse damage only"],
    },
    claim_ready_rules: ["ORBIT warehouse_damaged"],
    review_signal_rules: ["reason ambiguous"],
    exclusion_rules: ["customer return"],
    current_status: "live",
    missing_blocker: "Undifferentiated catch-all",
  },
  {
    family_key: "inventory_adjustment_error",
    display_name: "Inventory adjustment error",
    quantity: {
      source_tables: ["amazon_inventory_ledger", "amazon_reimbursements"],
      required_identifiers: ["fnsku", "ledger_reference_id"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "amazon_inventory_ledger", left_field: "reference_id", right_table: "amazon_reimbursements", right_field: "linked_keys", join_type: "left" },
      ],
      quantity_fields: ["ledger.quantity"],
      source_priority: ["1. catch-all unreconciled negative after specific families excluded"],
      conflict_handling: "Prefer specific family classification",
      exact_formula: "claim_quantity = ABS(unreconciled_negative) WHERE NOT classified_to_lost|damaged|destroy|return",
      claim_quantity: "ABS(unreconciled_negative)",
      confidence: { high: "Specific reason", medium: "Catch-all", low: "Unknown reason" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["ledger_reference", "product_link"],
      required_report_rows: ["ledger adjustment line"],
      required_files_images: [],
      deadline_window: "ledger.event_date + policy.adjustment_window_days",
      claim_readiness_rules: ["no better family match"],
    },
    claim_ready_rules: ["inventory_unreconciled_loss fallback"],
    review_signal_rules: ["manual classify needed"],
    exclusion_rules: ["classified elsewhere"],
    current_status: "partial",
    missing_blocker: "Reason taxonomy incomplete",
  },
  {
    family_key: "inbound_shipment_shortage",
    display_name: "Inbound shipment shortage",
    quantity: {
      source_tables: ["amazon_inbound_performance", "product_identifier_map"],
      required_identifiers: ["fba_shipment_id", "fnsku", "sku"],
      join_keys: [PRODUCT_LINKAGE_JOIN],
      quantity_fields: ["problem_quantity", "expected_quantity", "received_quantity"],
      source_priority: ["1. amazon_inbound_performance.problem_quantity"],
      conflict_handling: "Carton mapping conflict → review_signal",
      exact_formula: "claim_quantity = problem_quantity WHERE received_quantity < expected_quantity AND problem_level qualifies",
      claim_quantity: "problem_quantity",
      confidence: { high: "Performance row + linkage", medium: "Report only", low: "Stale shipment" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["shipment_scope", "product_link", "order_reference"],
      required_report_rows: ["amazon_inbound_performance"],
      required_files_images: ["Carton labels if disputed"],
      deadline_window: "issue_reported_date + policy.inbound_dispute_days",
      claim_readiness_rules: ["problem_qty > 0"],
    },
    claim_ready_rules: ["inbound_shipment generator"],
    review_signal_rules: ["carton ambiguous"],
    exclusion_rules: ["received full"],
    current_status: "live",
    missing_blocker: "Miscount not split",
  },
  {
    family_key: "inbound_receiving_miscount",
    display_name: "Inbound receiving miscount",
    quantity: {
      source_tables: ["amazon_inbound_performance"],
      required_identifiers: ["fba_shipment_id", "fnsku", "carton_id"],
      join_keys: [PRODUCT_LINKAGE_JOIN],
      quantity_fields: ["received_quantity", "expected_quantity"],
      source_priority: ["1. abs(received-expected) where problem_type=miscount"],
      conflict_handling: "Over-receive vs under-receive → different claim_reason",
      exact_formula: "claim_quantity = ABS(received_quantity - expected_quantity) WHERE problem_type='Miscount'",
      claim_quantity: "ABS(received - expected)",
      confidence: { high: "Carton-level", medium: "Shipment-level", low: "Aggregate" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis"),
    evidence: {
      trid_edges_required: ["shipment_scope", "product_link"],
      required_report_rows: ["inbound performance miscount row"],
      required_files_images: [],
      deadline_window: "issue_reported_date + policy.inbound_dispute_days",
      claim_readiness_rules: ["miscount classification"],
    },
    claim_ready_rules: ["NOT built — folded into shortage today"],
    review_signal_rules: ["classification uncertain"],
    exclusion_rules: ["within tolerance"],
    current_status: "partial",
    missing_blocker: "problem_type taxonomy not split",
  },
  {
    family_key: "missing_reimbursement",
    display_name: "Missing reimbursement",
    quantity: {
      source_tables: ["amazon_inventory_ledger", "amazon_reimbursements", "financial_reference_resolver"],
      required_identifiers: ["fnsku", "ledger_reference_id", "reimbursement_id"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "amazon_inventory_ledger", left_field: "event_key", right_table: "amazon_reimbursements", right_field: "linked_event_key", join_type: "anti", notes: "post grace" },
        { left_table: "source_row", left_field: "id", right_table: "financial_reference_resolver", right_field: "source_row_id", join_type: "left" },
      ],
      quantity_fields: ["ledger.quantity", "reimbursements.quantity_reimbursed_total"],
      source_priority: ["1. ledger reimbursable event", "2. anti-join reimbursements after grace"],
      conflict_handling: "Pending reimbursement → review_signal",
      exact_formula: "claim_quantity = GREATEST(0, ledger_event_qty - COALESCE(reimbursed_qty,0)) AFTER grace_days",
      claim_quantity: "GREATEST(0, expected_units - observed_units)",
      confidence: { high: "Ledger + grace + anti-reimbursement", medium: "Gap estimate", low: "Incomplete imports" },
    },
    money: moneyCogsFamily("estimated_amazon_reimbursement = claim_quantity * actual_cost_basis OR policy flat_rate_table[event_type]"),
    evidence: {
      trid_edges_required: ["ledger_reference", "claim_to_reimbursement anti", "product_link"],
      required_report_rows: ["ledger event", "reimbursements absence proof"],
      required_files_images: [],
      deadline_window: "ledger.event_date + grace + policy.reimbursement_filing_days",
      claim_readiness_rules: ["grace elapsed"],
    },
    claim_ready_rules: ["NOT built — generator gap"],
    review_signal_rules: ["pending processing"],
    exclusion_rules: ["non-reimbursable"],
    current_status: "gap",
    missing_blocker: "No missing-reimbursement detector",
  },
  {
    family_key: "partial_incorrect_reimbursement",
    display_name: "Partial/incorrect reimbursement",
    quantity: {
      source_tables: ["amazon_reimbursements", "amazon_inventory_ledger"],
      required_identifiers: ["reimbursement_id", "fnsku", "original_reimbursement_id"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "amazon_reimbursements", left_field: "reimbursement_id", right_table: "amazon_inventory_ledger", right_field: "linked_event", join_type: "left" },
      ],
      quantity_fields: ["quantity_reimbursed_total", "quantity_reimbursed_cash", "quantity_reimbursed_inventory"],
      source_priority: ["1. reimbursement row amount/qty", "2. ledger expected qty"],
      conflict_handling: "Clawback negative rows → separate reason",
      exact_formula: "claim_quantity = GREATEST(0, expected_qty - quantity_reimbursed_total) OR ABS(quantity) when clawback",
      claim_quantity: "GREATEST(0, expected - observed_qty)",
      confidence: { high: "reimbursement_id match", medium: "Amount delta", low: "Aggregate" },
    },
    money: {
      actual_cost_basis: "COALESCE(cost_snapshots, cogs_overrides) OR derive from report_amount/qty",
      estimated_amazon_reimbursement: "GREATEST(0, expected_amount - observed_amount) OR ABS(amount_total) for clawback",
      observed_reimbursement: "amazon_reimbursements.amount_total (observed lane)",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "Use amount_total as posted; do not re-net fees unless settlement shows separate lines",
      cost_source_priority: [...COST_SOURCE_PRIORITY_CHAIN],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "report_amount primary for clawbacks",
      actual_loss: "claim_quantity * actual_cost_basis when underpayment; clawback uses report amount",
    },
    evidence: {
      trid_edges_required: ["claim_to_reimbursement", "ledger_reference", "product_link"],
      required_report_rows: ["amazon_reimbursements row"],
      required_files_images: [],
      deadline_window: "approval_date + policy.reimbursement_dispute_days",
      claim_readiness_rules: ["delta > tolerance"],
    },
    claim_ready_rules: ["reimbursement_reversal negatives", "ORBIT clawback"],
    review_signal_rules: ["partial pay pending"],
    exclusion_rules: ["within tolerance"],
    current_status: "partial",
    missing_blocker: "Underpayment detection not built",
  },
  {
    family_key: "settlement_refund_anomaly",
    display_name: "Settlement/refund anomaly",
    quantity: {
      source_tables: ["amazon_settlements", "amazon_transactions"],
      required_identifiers: ["settlement_id", "order_id", "sku"],
      join_keys: [
        { left_table: "amazon_settlements", left_field: "settlement_id+line_id", right_table: "amazon_transactions", right_field: "transaction_id", join_type: "left" },
      ],
      quantity_fields: ["settlement.quantity", "amount"],
      source_priority: ["1. settlement line", "2. transaction corroboration"],
      conflict_handling: "One candidate per anomalous line",
      exact_formula: "claim_quantity = COALESCE(quantity, 1) per line WHERE amount anomaly",
      claim_quantity: "COALESCE(settlement.quantity, 1)",
      confidence: { high: "Settlement + order", medium: "Settlement", low: "Unparsed" },
    },
    money: {
      actual_cost_basis: "actual_cost_basis when qty known else NULL",
      estimated_amazon_reimbursement: "ABS(settlement.amount) for refund anomaly lines",
      observed_reimbursement: "settlement.amount IS observed financial posting",
      reimbursement_gap: "estimated - observed when comparing to expected inventory loss estimate",
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "Separate fee lines in settlement — map transaction-type",
      cost_source_priority: [...COST_SOURCE_PRIORITY_CHAIN],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "report_amount",
      actual_loss: GLOBAL_FORMULA_PRIMITIVES.actual_loss,
    },
    evidence: {
      trid_edges_required: ["claim_to_settlement", "order_reference"],
      required_report_rows: ["settlement line"],
      required_files_images: [],
      deadline_window: "posted_date + policy.settlement_dispute_days",
      claim_readiness_rules: ["anomaly classifier hit"],
    },
    claim_ready_rules: ["settlement_refund_review"],
    review_signal_rules: ["unclassified adjustment"],
    exclusion_rules: ["expected fee"],
    current_status: "live",
    missing_blocker: "Shallow anomaly taxonomy",
  },
  {
    family_key: "safet_followup",
    display_name: "SAFE-T follow-up",
    quantity: {
      source_tables: ["amazon_safet_claims", "amazon_reimbursements"],
      required_identifiers: ["safet_claim_id", "fnsku", "order_id"],
      join_keys: [
        { left_table: "amazon_safet_claims", left_field: "safet_claim_id", right_table: "amazon_reimbursements", right_field: "case_id|order_id", join_type: "left" },
      ],
      quantity_fields: ["safet quantity / 1 per case"],
      source_priority: ["1. amazon_safet_claims row"],
      conflict_handling: "Empty table → unavailable NULL not zero",
      exact_formula: "claim_quantity = COALESCE(safet_qty, 1) per open/underpaid case",
      claim_quantity: "COALESCE(safet_qty, 1)",
      confidence: { high: "SAFE-T + reimbursement", medium: "SAFE-T only", low: "Empty import" },
    },
    money: {
      actual_cost_basis: "NULL unless inventory units — then cost chain",
      estimated_amazon_reimbursement: "GREATEST(0, safet.claim_amount - COALESCE(safet.total_reimbursement_amount,0))",
      observed_reimbursement: "safet.total_reimbursement_amount OR linked reimbursements.amount_total",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: [...COST_SOURCE_PRIORITY_CHAIN],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "report_amount from SAFE-T",
      actual_loss: "estimated_amazon_reimbursement when COGS unavailable",
    },
    evidence: {
      trid_edges_required: ["safet_reference", "claim_to_reimbursement"],
      required_report_rows: ["amazon_safet_claims"],
      required_files_images: ["SAFE-T case export"],
      deadline_window: "claim_date + policy.safet_followup_days",
      claim_readiness_rules: ["open OR underpaid status", "table not empty"],
    },
    claim_ready_rules: ["safet_followup when rows exist"],
    review_signal_rules: ["SAFE-T import empty"],
    exclusion_rules: ["closed fully paid"],
    current_status: "partial",
    missing_blocker: "SAFE-T data empty on main org",
  },
  {
    family_key: "fba_fee_overcharge",
    display_name: "FBA fee overcharge",
    quantity: {
      source_tables: ["amazon_fee_preview", "amazon_settlements", "product_packaging_dimensions_current", "product_identifier_map"],
      required_identifiers: ["fnsku", "asin", "fee_type", "settlement_period"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "amazon_fee_preview", left_field: "fnsku+period", right_table: "amazon_settlements", right_field: "sku+posted_date", join_type: "inner" },
        { left_table: "product_identifier_map", left_field: "product_id", right_table: "product_packaging_dimensions_current", right_field: "product_id", join_type: "left" },
      ],
      quantity_fields: ["fee_preview units / 1 per SKU-period case"],
      source_priority: ["1. amazon_fee_preview charged", "2. recomputed from PC04 dims + fee schedule", "3. settlement fee lines"],
      conflict_handling: "Missing PC04 → review_signal only",
      exact_formula: "claim_quantity = 1 per (fnsku, fee_type, period) case; unit_count for display",
      claim_quantity: "1",
      confidence: { high: "Dims + preview + settlement", medium: "Preview only", low: "No dims" },
    },
    money: {
      actual_cost_basis: "NULL — fee family uses fee deltas not COGS",
      estimated_amazon_reimbursement: "fee_overcharge_gap when > 0",
      observed_reimbursement: "SUM(settlement FBA fee credits) if any",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: "charged_fee - expected_fee WHERE expected_fee = recomputed(packaging_dimensions_current, fee_schedule)",
      storage_overcharge_gap: null,
      fee_deductions: "Map referral/FBA/fulfillment components separately",
      cost_source_priority: ["PC04 dimensions", "fee_schedule table", "amazon_fee_preview"],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "high only with PC04 + preview",
      actual_loss: "fee_overcharge_gap (not COGS-based)",
    },
    evidence: {
      trid_edges_required: ["product_link", "claim_to_settlement", "source_evidence"],
      required_report_rows: ["amazon_fee_preview", "PC04 row"],
      required_files_images: ["Supplier carton dims photo"],
      deadline_window: "fee_charge_date + policy.fee_dispute_days",
      claim_readiness_rules: ["fee_overcharge_gap > tolerance", "PC04 present"],
    },
    claim_ready_rules: ["NOT built"],
    review_signal_rules: ["fee anomaly without recompute"],
    exclusion_rules: ["within tolerance"],
    current_status: "gap",
    missing_blocker: "Fee recompute engine missing",
  },
  {
    family_key: "monthly_storage_fee_overcharge",
    display_name: "Monthly storage fee overcharge",
    quantity: {
      source_tables: ["amazon_monthly_storage_fees", "product_packaging_dimensions_current", "amazon_settlements"],
      required_identifiers: ["fnsku", "month", "fulfillment_center"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "amazon_monthly_storage_fees", left_field: "fnsku+month", right_table: "product_packaging_dimensions_current", right_field: "product_id", join_type: "left" },
      ],
      quantity_fields: ["cubic_feet", "average_quantity_on_hand"],
      source_priority: ["1. storage fee report", "2. recomputed volume from PC04"],
      conflict_handling: "Missing volume → review_signal",
      exact_formula: "claim_quantity = 1 per (fnsku, month, fc) case",
      claim_quantity: "1",
      confidence: { high: "Dims + storage report", medium: "Report only", low: "No import" },
    },
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "storage_overcharge_gap",
      observed_reimbursement: "settlement storage credits",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: null,
      storage_overcharge_gap: "charged_storage_fee - expected_storage_fee; expected = f(cubic_feet, rate_card, month)",
      fee_deductions: "long-term vs standard rate tiers",
      cost_source_priority: ["PC04 volume", "storage rate card"],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "requires volume proof",
      actual_loss: "storage_overcharge_gap",
    },
    evidence: {
      trid_edges_required: ["product_link", "claim_to_settlement"],
      required_report_rows: ["amazon_monthly_storage_fees"],
      required_files_images: ["Volume proof"],
      deadline_window: "month_end + policy.storage_dispute_days",
      claim_readiness_rules: ["storage_overcharge_gap > tolerance"],
    },
    claim_ready_rules: ["NOT built"],
    review_signal_rules: ["volume missing"],
    exclusion_rules: ["de minimis"],
    current_status: "gap",
    missing_blocker: "No generator",
  },
  {
    family_key: "dimension_weight_fee_issue",
    display_name: "Dimension/weight fee issue",
    quantity: {
      source_tables: ["product_packaging_dimensions_current", "amazon_fee_preview", "amazon_settlements"],
      required_identifiers: ["fnsku", "dimension_set_id"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "product_packaging_dimensions_current", left_field: "product_id", right_table: "amazon_fee_preview", right_field: "fnsku", join_type: "inner" },
      ],
      quantity_fields: ["1 case per SKU dimension dispute"],
      source_priority: ["1. PC04 measured dims", "2. fee_preview tier", "3. settlement historical fees"],
      conflict_handling: "Conflicting dim sources → review_signal",
      exact_formula: "claim_quantity = 1 per SKU dimension correction case",
      claim_quantity: "1",
      confidence: { high: "Measured dims + preview", medium: "Catalog dims", low: "No dims" },
    },
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "cumulative fee_overcharge_gap over lookback_window",
      observed_reimbursement: "fee credits after dimension correction",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: "SUM(charged_fee - expected_fee) per month in lookback",
      storage_overcharge_gap: null,
      fee_deductions: "FBA fulfillment size tier changes",
      cost_source_priority: ["PC04", "fee_schedule"],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "high with measured dims",
      actual_loss: "fee_overcharge_gap cumulative",
    },
    evidence: {
      trid_edges_required: ["product_link", "source_evidence"],
      required_report_rows: ["PC04", "fee_preview"],
      required_files_images: ["Carton measurement photos"],
      deadline_window: "first_fee_impact + policy.fee_lookback_days",
      claim_readiness_rules: ["tier mismatch proven"],
    },
    claim_ready_rules: ["NOT built"],
    review_signal_rules: ["dim drift signal"],
    exclusion_rules: ["within tier tolerance"],
    current_status: "gap",
    missing_blocker: "Fee recompute + TRID",
  },
  {
    family_key: "low_inventory_fee_issue",
    display_name: "Low inventory fee issue",
    quantity: {
      source_tables: ["amazon_manage_fba_inventory", "amazon_reserved_inventory", "planned: low_inventory_fee_report"],
      required_identifiers: ["fnsku", "asin", "fee_month"],
      join_keys: [PRODUCT_LINKAGE_JOIN],
      quantity_fields: ["fee_units / 1 per SKU-month"],
      source_priority: ["1. low-inventory fee report when imported", "2. manage_fba_inventory threshold signals"],
      conflict_handling: "Report not imported → review_signal unavailable",
      exact_formula: "claim_quantity = 1 per (fnsku, fee_month) OR fee_unit_count from report",
      claim_quantity: "COALESCE(report.fee_units, 1)",
      confidence: { high: "Fee report + inventory snapshot", medium: "Inventory signal", low: "No report" },
    },
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "fee_overcharge_gap = charged_low_inventory_fee - expected_fee (expected=0 if above threshold)",
      observed_reimbursement: "settlement low-inventory fee credits",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: "charged_fee - expected_fee",
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: ["low_inventory_fee_report", "manage_fba_inventory thresholds"],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "requires fee report import",
      actual_loss: "fee_overcharge_gap",
    },
    evidence: {
      trid_edges_required: ["product_link", "claim_to_settlement"],
      required_report_rows: ["Low-Inventory-Level Fee report (file-first)"],
      required_files_images: [],
      deadline_window: "fee_month + policy.fee_dispute_days",
      claim_readiness_rules: ["report imported", "threshold evidence"],
    },
    claim_ready_rules: ["NOT built"],
    review_signal_rules: ["report missing"],
    exclusion_rules: ["legitimate low-stock fee"],
    current_status: "gap",
    missing_blocker: "No table/importer for low-inventory fee report",
  },
  {
    family_key: "returns_processing_fee_issue",
    display_name: "Returns processing fee issue",
    quantity: {
      source_tables: ["planned: returns_processing_fee_report", "amazon_returns", "amazon_settlements"],
      required_identifiers: ["fnsku", "return_id", "fee_period"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "returns_processing_fee", left_field: "return_id", right_table: "amazon_returns", right_field: "return_id", join_type: "inner" },
      ],
      quantity_fields: ["1 per return fee line"],
      source_priority: ["1. returns processing fee report", "2. settlement fee lines"],
      conflict_handling: "Report unsupported → review_signal",
      exact_formula: "claim_quantity = 1 per disputed return processing fee line",
      claim_quantity: "1",
      confidence: { high: "Report + return match", medium: "Settlement line", low: "No report" },
    },
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "fee_overcharge_gap = charged_processing_fee - expected_processing_fee",
      observed_reimbursement: "settlement credits",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: "charged_fee - expected_fee",
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: ["returns_processing_fee_report", "fee_schedule"],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "requires report import",
      actual_loss: "fee_overcharge_gap",
    },
    evidence: {
      trid_edges_required: ["product_link", "order_reference", "claim_to_settlement"],
      required_report_rows: ["Returns Processing Fee report (file-first)"],
      required_files_images: [],
      deadline_window: "fee_date + policy.fee_dispute_days",
      claim_readiness_rules: ["report imported"],
    },
    claim_ready_rules: ["NOT built"],
    review_signal_rules: ["unsupported file type"],
    exclusion_rules: ["valid fee per policy"],
    current_status: "gap",
    missing_blocker: "No importer — sample zip unsupported",
  },
  {
    family_key: "inbound_placement_fee_issue",
    display_name: "Inbound placement fee issue",
    quantity: {
      source_tables: ["planned: inbound_placement_fees_report", "amazon_inbound_performance", "amazon_settlements"],
      required_identifiers: ["fba_shipment_id", "fnsku", "placement_option"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "inbound_placement_fees", left_field: "shipment_id", right_table: "amazon_inbound_performance", right_field: "fba_shipment_id", join_type: "inner" },
      ],
      quantity_fields: ["1 per placement fee line"],
      source_priority: ["1. inbound placement fee report", "2. settlement placement lines"],
      conflict_handling: "Report unsupported → review_signal",
      exact_formula: "claim_quantity = 1 per disputed placement fee line",
      claim_quantity: "1",
      confidence: { high: "Report + inbound shipment", medium: "Settlement", low: "No report" },
    },
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "fee_overcharge_gap = charged_placement_fee - expected_placement_fee",
      observed_reimbursement: "settlement placement credits",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: "charged_fee - expected_fee",
      storage_overcharge_gap: null,
      fee_deductions: "placement service fee components",
      cost_source_priority: ["inbound_placement_report", "inbound fee schedule"],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "requires report import",
      actual_loss: "fee_overcharge_gap",
    },
    evidence: {
      trid_edges_required: ["shipment_scope", "product_link", "claim_to_settlement"],
      required_report_rows: ["Inbound Placement Service Fees (file-first)"],
      required_files_images: [],
      deadline_window: "shipment_creation + policy.inbound_fee_dispute_days",
      claim_readiness_rules: ["report imported"],
    },
    claim_ready_rules: ["NOT built"],
    review_signal_rules: ["unsupported file"],
    exclusion_rules: ["valid placement fee"],
    current_status: "gap",
    missing_blocker: "No importer — sample zip unsupported",
  },
  {
    family_key: "stranded_expired_review_signal",
    display_name: "Stranded/expired review signal",
    quantity: {
      source_tables: ["amazon_manage_fba_inventory", "amazon_reserved_inventory", "amazon_inventory_ledger"],
      required_identifiers: ["fnsku", "asin", "stranded_reason"],
      join_keys: [PRODUCT_LINKAGE_JOIN],
      quantity_fields: ["stranded_units display only"],
      source_priority: ["1. stranded report when available", "2. ledger expired/stranded hints"],
      conflict_handling: "Never auto-candidate qty — signal only",
      exact_formula: "claim_quantity = NULL; display_qty = stranded_units FROM report",
      claim_quantity: "NULL",
      confidence: { high: "Stranded report + linkage", medium: "Ledger hint", low: "No table" },
    },
    money: {
      actual_cost_basis: "NULL",
      estimated_amazon_reimbursement: "NULL at signal stage",
      observed_reimbursement: "NULL",
      reimbursement_gap: "NULL",
      fee_overcharge_gap: null,
      storage_overcharge_gap: null,
      fee_deductions: "none",
      cost_source_priority: [],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "unavailable at signal stage",
      actual_loss: "NULL",
    },
    evidence: {
      trid_edges_required: ["product_link", "ledger_reference"],
      required_report_rows: ["stranded inventory report when imported"],
      required_files_images: [],
      deadline_window: "N/A — operator must classify to target family",
      claim_readiness_rules: ["NEVER auto claim-ready from stranded alone"],
    },
    claim_ready_rules: ["EXCLUDE auto-candidate"],
    review_signal_rules: ["ALWAYS at detection"],
    exclusion_rules: ["Auto money claims"],
    current_status: "gap",
    missing_blocker: "No stranded table/import",
  },
  {
    family_key: "orbit_fra_fight_list",
    display_name: "ORBIT/FRA fight-list candidate",
    quantity: {
      source_tables: [
        "amazon_reimbursements",
        "amazon_settlements",
        "amazon_inventory_ledger",
        "amazon_removals",
        "amazon_removal_shipments",
        "expected_packages",
        "return_items",
        "amazon_safet_claims",
        "amazon_inbound_performance",
      ],
      required_identifiers: ["category_key", "fnsku/sku/asin", "source_row_id"],
      join_keys: [
        PRODUCT_LINKAGE_JOIN,
        { left_table: "category_source", left_field: "id", right_table: "financial_reference_resolver", right_field: "source_row_id", join_type: "left" },
      ],
      quantity_fields: ["Per-category: units from source row OR 1 for amount-based"],
      source_priority: ["1. ORBIT category rule", "2. underlying family source_priority", "3. clean EP filters"],
      conflict_handling: "Apply DISPUTED_EP_EXCLUDE + removal supersession on all quantity paths",
      exact_formula: "claim_quantity = category.units OR ABS(ledger.qty) OR clean EP qty per ORBIT category handler",
      claim_quantity: "Per ORBIT category — see claim-orbit-fra-generator.ts handlers",
      confidence: { high: "Multi-report agreement + COGS", medium: "Single report", low: "Workbook stale" },
    },
    money: {
      actual_cost_basis: "COGS resolver chain — NEVER unit_sale_price",
      estimated_amazon_reimbursement: "IF claim_quantity>0 AND cogs NOT NULL THEN claim_quantity*cogs ELSE reportAmount",
      observed_reimbursement: "Source report amount fields + reimbursements join",
      reimbursement_gap: GLOBAL_FORMULA_PRIMITIVES.reimbursement_gap,
      fee_overcharge_gap: "When category is fee-type",
      storage_overcharge_gap: "When category is storage-type",
      fee_deductions: "Per category",
      cost_source_priority: [...COST_SOURCE_PRIORITY_CHAIN],
      sale_price_usage_rule: SALE_PRICE_RULE,
      source_confidence: "Varies per category",
      actual_loss: GLOBAL_FORMULA_PRIMITIVES.actual_loss,
    },
    evidence: {
      trid_edges_required: ["All edges for underlying family", "source_evidence", "product_link"],
      required_report_rows: ["Matching ORBIT source report row"],
      required_files_images: ["ORBIT workbook row citation when used"],
      deadline_window: "Per underlying family",
      claim_readiness_rules: ["category enabled", "clean qty", "dedupe prefers orbit over scanner twin"],
    },
    claim_ready_rules: ["orbit_fra generator — 18 categories"],
    review_signal_rules: ["XLSX import blocked", "category ambiguous"],
    exclusion_rules: ["legacy_seed"],
    current_status: "live",
    missing_blocker: "Workbook import blocked; COGS feed empty",
  },
] as const;

/** Derived exports for read-model API. */
export const QUANTITY_FORMULA_BY_FAMILY_V2 = Object.fromEntries(
  CLAIM_FAMILY_FORMULA_MATRIX.map((e) => [e.family_key, e.quantity]),
) as Record<ClaimFamilyFormulaKey, QuantityFormulaContract>;

export const MONEY_FORMULA_BY_FAMILY_V2 = Object.fromEntries(
  CLAIM_FAMILY_FORMULA_MATRIX.map((e) => [e.family_key, e.money]),
) as Record<ClaimFamilyFormulaKey, MoneyFormulaContract>;

export const SOURCE_JOIN_KEYS_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_FORMULA_MATRIX.map((e) => [e.family_key, e.quantity.join_keys]),
) as Record<ClaimFamilyFormulaKey, JoinKeySpec[]>;

export const TRID_EDGE_REQUIREMENTS_V2 = Object.fromEntries(
  CLAIM_FAMILY_FORMULA_MATRIX.map((e) => [e.family_key, e.evidence.trid_edges_required]),
) as Record<ClaimFamilyFormulaKey, string[]>;

export const CLAIM_READY_RULES_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_FORMULA_MATRIX.map((e) => [e.family_key, [...CLAIM_READY_RULES_GLOBAL, ...e.claim_ready_rules]]),
) as Record<ClaimFamilyFormulaKey, string[]>;

export const REVIEW_SIGNAL_RULES_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_FORMULA_MATRIX.map((e) => [e.family_key, [...REVIEW_SIGNAL_RULES_GLOBAL, ...e.review_signal_rules]]),
) as Record<ClaimFamilyFormulaKey, string[]>;

export const EXCLUSION_RULES_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_FORMULA_MATRIX.map((e) => [e.family_key, [...EXCLUSION_RULES_GLOBAL, ...e.exclusion_rules]]),
) as Record<ClaimFamilyFormulaKey, string[]>;

export const FIRST_5_FAMILIES_TO_IMPLEMENT: readonly ClaimFamilyFormulaKey[] = [
  "customer_return_not_reimbursed",
  "physical_return_scanner_issue",
  "removal_order_discrepancy",
  "missing_reimbursement",
  "orbit_fra_fight_list",
] as const;

export const SAFE_TO_IMPLEMENT_CLAIM_CALCULATION_READMODEL = "yes" as const;

export const NEXT_EXACT_PROMPT_V2 = `PHASE-CLAIM-FAMILY-CALCULATION-READMODEL-IMPLEMENT-V1

Mode: read-model API only — expose CLAIM_FAMILY_FORMULA_MATRIX via GET /api/claims/center/calculation-contract.

Do not write DB. Do not mutate claim_candidates. Do not implement generators.

Implement:
1. API handler returning quantity + money + evidence + join_keys per family
2. Claim Center "Calculation contract" panel with formula display
3. Dry-run evaluator shell (NULL-safe, no writes) for sample product/trace
4. Smoke + build for 27 families

First generator dry-run after API: customer_return_not_reimbursed join proof on staging.` as const;

export function getClaimFamilyFormulaEntry(key: ClaimFamilyFormulaKey): ClaimFamilyFormulaEntry | undefined {
  return CLAIM_FAMILY_FORMULA_MATRIX.find((e) => e.family_key === key);
}
