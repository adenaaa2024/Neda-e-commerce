/**
 * PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V1
 * Read-only claim algorithm contract — quantity, money, sources, TRID, blockers.
 * No DB writes. No generator implementation. Maysam approval gate for money schema changes.
 */

import { EXPECTED_PACKAGE_SOURCE_PRIORITY_RULES } from "@/lib/expected-packages-conflict-status";

/** Canonical family keys — stable contract IDs (may differ from legacy claim_family strings in DB). */
export type ClaimFamilyAlgorithmKey =
  | "physical_return_scanner_issue"
  | "customer_return_not_reimbursed"
  | "refund_without_return"
  | "wrong_item_returned"
  | "empty_box_return"
  | "customer_damaged_return"
  | "removal_order_discrepancy"
  | "removal_shipment_missing_damaged"
  | "disposed_without_reimbursement"
  | "warehouse_lost_inventory"
  | "warehouse_damaged_inventory"
  | "inventory_adjustment_error"
  | "inbound_shipment_shortage"
  | "inbound_receiving_miscount"
  | "reimbursement_missing"
  | "reimbursement_partial_incorrect"
  | "settlement_refund_anomaly"
  | "safet_followup"
  | "fba_fee_overcharge"
  | "monthly_storage_fee_overcharge"
  | "dimension_weight_fee_issue"
  | "stranded_expired_review_signal"
  | "orbit_fra_fight_list";

export type ImplementationStatus =
  | "live"
  | "partial"
  | "review_signal_only"
  | "planned"
  | "gap";

export type ImplementationPriority = "P0" | "P1" | "P2" | "P3" | "deferred";

export type ProductLinkageRequirement =
  | "required_before_trusted_money"
  | "required_before_product_story"
  | "recommended"
  | "identifier_only"
  | "not_applicable";

export type CandidateEmitRule =
  | "create_candidate"
  | "review_signal_only"
  | "exclude"
  | "defer_until_linkage"
  | "defer_until_evidence";

export type ClaimFamilyAlgorithmEntry = {
  family_key: ClaimFamilyAlgorithmKey;
  display_name: string;
  /** Amazon item lifecycle state(s) this family addresses. */
  lifecycle_states: string[];
  /** Primary source tables, files, or APIs. */
  source_tables_files_api: string[];
  /** Minimum identifiers for detection (exact match only — no title). */
  required_identifiers: string[];
  product_linkage_requirement: ProductLinkageRequirement;
  /** Plain-language quantity logic. */
  quantity_formula: string;
  /** Plain-language amount / exposure logic. */
  amount_formula: string;
  /** Expected recovery at intake (operator-facing exposure). */
  expected_recovery_formula: string;
  /** Observed reimbursement from Amazon imports / case status — separate lane. */
  observed_reimbursement_formula: string;
  /** Actual economic loss — never substitutes sale price for COGS. */
  actual_loss_formula: string;
  /** Where unit cost must come from; null = unavailable not zero. */
  cost_source_requirement: string;
  /** Sale/list price is context only, never COGS substitute. */
  sale_price_display_only: boolean;
  /** Canonical event_date derivation. */
  event_date: string;
  /** Filing / dispute window rules. */
  deadline_window: string;
  evidence_requirements: string[];
  trid_edges_required: string[];
  claim_readiness_rules: string[];
  disputed_source_conflict_handling: string;
  confidence_levels: { high: string; medium: string; low: string };
  when_create_candidate: string;
  when_review_signal_only: string;
  when_exclude: string;
  current_implementation_status: ImplementationStatus;
  /** Maps to existing generator claim_family / source_kind when present. */
  existing_code_mapping: string | null;
  missing_blocker: string;
  implementation_priority: ImplementationPriority;
};

/** Global hard rules — apply to every family. */
export const CLAIM_ALGORITHM_HARD_RULES = [
  "Never use sale price as COGS.",
  "Unknown cost is unknown (null), not zero.",
  "Empty source is unavailable (null), not zero.",
  "Disputed expected_packages / superseded removal detail rows do not become claim-ready.",
  "Observed reimbursement is separate from expected recovery.",
  "Product linkage (product_identifier_map) required before Product Story and trusted money.",
  "No title-only matching.",
  "No product auto-create from scanner/OCR/raw reports.",
  "legacy_seed / quarantined candidates are never source of truth.",
] as const;

export const DISPUTED_DATA_RULES = {
  expected_packages: {
    clean_build_statuses: ["matched", "expected", "resolved", "complete"],
    disputed_build_statuses: [
      "shipment_overflow_conflict",
      "detail_remainder",
      "source_conflict",
      "stale_partial_snapshot",
      "duplicate_source_conflict",
    ],
    policy: "Only clean EP quantity enters claim quantity formulas; disputed qty → review_signal_only.",
    source_priority: EXPECTED_PACKAGE_SOURCE_PRIORITY_RULES,
  },
  amazon_removals: {
    policy:
      "Superseded partial detail rows (older upload/API) are stale — exclude from clean quantity; flag review_signal.",
    readmodel: "removal-source-supersession-readmodel.ts",
  },
  general: {
    policy: "When sources disagree, do_not_auto_pick_claim_quantity.",
    claim_ready: "needs_source_reconciliation → review_signal_only, never auto-candidate with disputed qty.",
  },
} as const;

export const CONFIDENCE_RULES = {
  high: "Exact identifier match (FNSKU/ASIN/SKU via product_identifier_map) + single authoritative source row + clean build_status + physical scan or API primary key match.",
  medium: "Identifier match + multi-source agreement OR policy-allowed live scanner emit with closed package evidence.",
  low: "Identifier-only from report without linkage, conflicting sources, stale partial snapshot, or orphan scan without manifest line.",
  gates: {
    trusted_money: "confidence >= medium AND product_linkage resolved AND cost_source != unavailable",
    create_candidate: "confidence >= medium AND quantity > 0 AND not disputed AND source_enabled",
    review_signal_only: "disputed OR linkage unresolved OR evidence incomplete OR source stale",
  },
} as const;

export const CREATE_CANDIDATE_VS_REVIEW_SIGNAL_RULES = {
  create_candidate: [
    "Clean quantity > 0",
    "Source kind enabled in intake policy",
    "Not legacy_seed / quarantined",
    "Not disputed EP or superseded removal detail",
    "Meets family-specific minimum evidence (see entry)",
    "Within claim window (not expired / not pre-cutoff)",
  ],
  review_signal_only: [
    "Disputed expected_packages build_status",
    "Removal source supersession conflict",
    "Product linkage unresolved but identifier present",
    "Conflicting shipment vs detail quantities",
    "Stranded/expired inventory signal (no auto-claim qty)",
    "Fee anomaly detected but cost/dimension spine incomplete",
  ],
  exclude: [
    "Test seed / voided package / off-slip test rows",
    "legacy_seed without trusted corroboration",
    "Quantity = 0 after clean filter",
    "Source disabled by policy",
    "Expired past dispute deadline with no extension",
    "Duplicate dedupe_key already filed/reimbursed",
  ],
  defer_until_linkage: ["require_product_link=true AND !resolved_product_id"],
  defer_until_evidence: ["physical return without package close OR missing TRID anchor"],
} as const;

const QTY = {
  physical_scan: "qty = count(return_items) WHERE physical_event matches family AND NOT test_seed AND package not voided",
  physical_vs_expected:
    "qty = max(0, actual_scanned - expected_clean) OR max(0, expected_clean - actual_scanned) per family direction; expected_clean = sum(clean EP only)",
  removal_detail:
    "qty = max(0, removal_detail_shipped_qty - removal_shipment_received_qty) on clean matched rows only",
  ledger_negative: "qty = abs(unreconciled_negative_qty) from inventory_ledger WHERE reason_code matches family",
  inbound_problem: "qty = problem_quantity from amazon_inbound_performance WHERE problem_level qualifies",
  reimbursement_gap:
    "qty = max(0, expected_reimburse_units - observed_reimbursed_units) from ledger/returns cross-check",
  fee_units: "qty = affected_unit_count OR fee_line_count (display); claim qty often 1 case per SKU-period",
  signal_only: "qty = null for auto-candidate; signal carries count for operator review",
} as const;

const MONEY = {
  cogs_exposure: "expected_recovery = clean_qty × unit_cost; unit_cost from cost_history/override; NULL if unknown",
  report_amount: "expected_recovery = abs(report_amount) from reimbursement/settlement/SAFE-T row",
  fee_delta: "expected_recovery = max(0, charged_fee - recomputed_fee); NULL until dimension spine + fee preview",
  observed: "observed_reimbursement = sum(amazon_reimbursements.amount) for linked keys; separate field",
  actual_loss: "actual_loss = clean_qty × unit_cost when cost known; else NULL",
  sale_context: "sale_price × qty = display_context_only; never substitutes COGS",
} as const;

/** Full matrix — 23 families. */
export const CLAIM_FAMILY_ALGORITHM_MATRIX: readonly ClaimFamilyAlgorithmEntry[] = [
  {
    family_key: "physical_return_scanner_issue",
    display_name: "Physical return scanner issue",
    lifecycle_states: ["fba_return_received", "warehouse_received_return", "return_issue_flagged"],
    source_tables_files_api: ["return_items", "packages", "expected_packages (clean only)"],
    required_identifiers: ["fnsku OR asin OR sku", "package_id", "tracking_number (when on manifest)"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: `${QTY.physical_scan} AND physical_event IN (damaged, wrong_item, expired, unexpected_item, missing)`,
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "clean_qty × resolved_unit_cost; NULL if cost unavailable",
    observed_reimbursement_formula: "SUM(reimbursements) WHERE reimbursement_type matches return family AND keys join",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "workspace cogs_overrides → cost_history → return_items.estimated_value (never sale_price)",
    sale_price_display_only: true,
    event_date: "return_items.scanned_at OR package.closed_at",
    deadline_window: "policy.claim_window_days from event_date; closing_soon = last 14d hardcoded",
    evidence_requirements: ["Closed package", "Operator condition tag", "Slip/label photo optional per policy"],
    trid_edges_required: ["product_link", "shipment_scope OR package_id", "source_evidence"],
    claim_readiness_rules: ["physical_event claimable per intake policy", "NOT test_seed", "package closed for box_close emit"],
    disputed_source_conflict_handling: "Manifest expected uses clean EP only; off-manifest uses scan count only",
    confidence_levels: {
      high: "Resolved product + closed package + matching FNSKU scan",
      medium: "Scan + identifier without full linkage",
      low: "Orphan / off-manifest without resolver",
    },
    when_create_candidate: "Live emit on box_close / per_problem_scan when policy allows",
    when_review_signal_only: "Linkage unresolved OR ambiguous twin with orbit_fra",
    when_exclude: "Voided package, test seed, legacy_seed",
    current_implementation_status: "live",
    existing_code_mapping: "source_kind=scanner_physical_review, claim_family=physical_return_issue; live emitters",
    missing_blocker: "TRID edges sparse; cost spine incomplete for many SKUs",
    implementation_priority: "P0",
  },
  {
    family_key: "customer_return_not_reimbursed",
    display_name: "Customer return not reimbursed",
    lifecycle_states: ["fba_customer_return_received", "return_not_reimbursed"],
    source_tables_files_api: ["amazon_returns / fba_customer_returns", "amazon_inventory_ledger", "amazon_reimbursements"],
    required_identifiers: ["fnsku", "asin", "order_id OR return_id", "license_plate OR tracking"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: `${QTY.reimbursement_gap}: returned_units - reimbursed_units per return event`,
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "gap_qty × unit_cost; fallback NULL (not sale price)",
    observed_reimbursement_formula: "SUM(reimbursements.amount) for return_id / order_id join",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "cost_history / cogs_overrides required for trusted money",
    sale_price_display_only: true,
    event_date: "amazon_returns.return_date OR ledger event_date",
    deadline_window: "Amazon FBA return reimbursement window per policy (configurable)",
    evidence_requirements: ["Return report row", "Ledger customer-return event", "Absence proof for reimbursement"],
    trid_edges_required: ["product_link", "order_reference", "ledger_reference", "claim_to_reimbursement (negative space)"],
    claim_readiness_rules: ["Return received in ledger", "No matching reimbursement within grace period"],
    disputed_source_conflict_handling: "Conflicting return counts between report versions → review_signal",
    confidence_levels: {
      high: "Return row + ledger + linkage + no reimbursement match",
      medium: "Return import only, reimbursement table current",
      low: "Stale return file or missing ledger",
    },
    when_create_candidate: "Gap qty > 0 after cross-check AND linkage resolved",
    when_review_signal_only: "Multiple return file versions disagree",
    when_exclude: "Already reimbursed; return disposition not reimbursable",
    current_implementation_status: "gap",
    existing_code_mapping: "legacy AMAZON_RETURNS_FBA drafts only — no 7C generator",
    missing_blocker: "No trusted generator; FBA returns → reimbursement join not built",
    implementation_priority: "P0",
  },
  {
    family_key: "refund_without_return",
    display_name: "Refund without return",
    lifecycle_states: ["customer_refund_issued", "inventory_not_returned"],
    source_tables_files_api: ["amazon_settlements", "amazon_transactions", "amazon_inventory_ledger"],
    required_identifiers: ["order_id", "sku/fnsku", "settlement_id OR transaction_id"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "qty = refunded_units from settlement line WHERE no matching return ledger inbound",
    amount_formula: MONEY.report_amount,
    expected_recovery_formula: "abs(settlement_refund_amount) OR qty × unit_cost when units known",
    observed_reimbursement_formula: "N/A — refund is observed; claim is recovery of inventory loss",
    actual_loss_formula: "qty × unit_cost when inventory still held or lost",
    cost_source_requirement: "unit_cost for inventory loss lane",
    sale_price_display_only: true,
    event_date: "settlement.posted_date OR transaction_date",
    deadline_window: "Settlement dispute window per policy",
    evidence_requirements: ["Settlement refund line", "No return ledger match", "Order shipment proof"],
    trid_edges_required: ["claim_to_settlement", "order_reference", "ledger_reference", "product_link"],
    claim_readiness_rules: ["Negative settlement/refund", "No return receipt within lookback"],
    disputed_source_conflict_handling: "Partial refunds split — review_signal per line",
    confidence_levels: {
      high: "Settlement + order + no return",
      medium: "Settlement only",
      low: "Transaction without settlement tie",
    },
    when_create_candidate: "Refund amount > threshold AND inventory loss evidenced",
    when_review_signal_only: "Ambiguous partial refund split",
    when_exclude: "Goodwill refund / non-inventory SKU",
    current_implementation_status: "partial",
    existing_code_mapping: "settlement_refund_review (negative refunds) — not explicit without-return family",
    missing_blocker: "No return cross-check join; family not split from generic settlement review",
    implementation_priority: "P1",
  },
  {
    family_key: "wrong_item_returned",
    display_name: "Wrong item returned",
    lifecycle_states: ["return_wrong_item", "physical_return_issue"],
    source_tables_files_api: ["return_items", "expected_packages (clean)", "amazon_returns"],
    required_identifiers: ["scanned_fnsku", "expected_fnsku", "package_id"],
    product_linkage_requirement: "required_before_product_story",
    quantity_formula: "qty = 1 per wrong_item scan event (physical_event=wrong_item)",
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "qty × expected_product_unit_cost",
    observed_reimbursement_formula: "Observed return reimbursement for wrong SKU if any",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "Both products need cost for net loss; else NULL",
    sale_price_display_only: true,
    event_date: "return_items.scanned_at",
    deadline_window: "Same as physical return policy",
    evidence_requirements: ["Operator wrong_item tag", "Photo of label", "Expected vs scanned identifier"],
    trid_edges_required: ["product_link (both SKUs)", "shipment_scope", "source_evidence"],
    claim_readiness_rules: ["physical_event=wrong_item", "expected ≠ scanned identifier"],
    disputed_source_conflict_handling: "Expected manifest disputed → use scan-only qty",
    confidence_levels: { high: "Scan mismatch + closed package", medium: "Operator flag only", low: "No expected line" },
    when_create_candidate: "wrong_item tag + closed package",
    when_review_signal_only: "Expected line disputed",
    when_exclude: "Same SKU typo normalization match",
    current_implementation_status: "partial",
    existing_code_mapping: "physical_return_issue + operator_flagged_wrong_item",
    missing_blocker: "No dedicated family split; dual-product cost logic missing",
    implementation_priority: "P1",
  },
  {
    family_key: "empty_box_return",
    display_name: "Empty box return",
    lifecycle_states: ["return_empty_package", "shipment_received_empty"],
    source_tables_files_api: ["return_items", "packages", "expected_packages (clean)"],
    required_identifiers: ["package_id", "tracking_number", "manifest line identifiers"],
    product_linkage_requirement: "recommended",
    quantity_formula: "qty = expected_clean WHEN actual_scanned=0 AND package closed",
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "expected_clean × unit_cost",
    observed_reimbursement_formula: "Observed reimbursement if Amazon credited empty return",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost for expected SKU",
    sale_price_display_only: true,
    event_date: "package.closed_at",
    deadline_window: "Physical return window",
    evidence_requirements: ["Box close with 0 scans", "Expected > 0", "Empty box photo policy"],
    trid_edges_required: ["shipment_scope", "package_id", "product_link"],
    claim_readiness_rules: ["actual_scanned_count=0", "expected_clean>0", "box_close emit"],
    disputed_source_conflict_handling: "Use clean expected only — never disputed overflow qty",
    confidence_levels: { high: "Closed box + clean expected", medium: "Expected from EP", low: "No manifest" },
    when_create_candidate: "Live empty_box_received emitter",
    when_review_signal_only: "Disputed EP only",
    when_exclude: "Intentional empty manifest line",
    current_implementation_status: "live",
    existing_code_mapping: "empty_box_received live emitter; physical_return_issue family",
    missing_blocker: "Scheduled generator does not separate empty_box",
    implementation_priority: "P1",
  },
  {
    family_key: "customer_damaged_return",
    display_name: "Customer damaged return",
    lifecycle_states: ["return_damaged_by_customer", "physical_return_damaged"],
    source_tables_files_api: ["return_items", "amazon_returns", "amazon_inventory_ledger"],
    required_identifiers: ["fnsku", "return_id OR package_id"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "qty = count(scans WHERE physical_event=damaged AND disposition=customer_damage)",
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "qty × unit_cost",
    observed_reimbursement_formula: "Reimbursement if Amazon reimbursed damaged return",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost required",
    sale_price_display_only: true,
    event_date: "return_items.scanned_at",
    deadline_window: "Return reimbursement window",
    evidence_requirements: ["Damage tag", "Photos", "Return report row"],
    trid_edges_required: ["product_link", "ledger_reference", "source_evidence"],
    claim_readiness_rules: ["Customer damage disposition", "Not warehouse damage"],
    disputed_source_conflict_handling: "Disposition conflict → review_signal",
    confidence_levels: { high: "Scan + disposition + linkage", medium: "Report only", low: "Tag without photo" },
    when_create_candidate: "Damaged scan + policy allows",
    when_review_signal_only: "ORBIT physical_return_damaged twin — dedupe prefers orbit",
    when_exclude: "Warehouse damage (different family)",
    current_implementation_status: "partial",
    existing_code_mapping: "physical_return_issue + ORBIT physical_return_damaged",
    missing_blocker: "Customer vs warehouse damage split incomplete",
    implementation_priority: "P1",
  },
  {
    family_key: "removal_order_discrepancy",
    display_name: "Removal order discrepancy",
    lifecycle_states: ["removal_order_created", "removal_detail_vs_shipment_mismatch"],
    source_tables_files_api: ["amazon_removals", "amazon_removal_shipments", "expected_packages (clean)"],
    required_identifiers: ["removal_order_id", "fnsku", "sku", "source_detail_row_id"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: `${QTY.removal_detail}: max(0, detail_qty - shipment_qty) on non-superseded detail rows`,
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "gap_qty × unit_cost",
    observed_reimbursement_formula: "Removal reimbursement rows if any",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "removal detail request_date OR shipment ship_date",
    deadline_window: "Removal dispute window per policy",
    evidence_requirements: ["Removal order report", "Shipment report", "Clean EP alignment"],
    trid_edges_required: ["order_reference", "claim_to_removal", "claim_to_shipment", "product_link"],
    claim_readiness_rules: ["Clean EP qty only", "Superseded partial excluded"],
    disputed_source_conflict_handling: "shipment_overflow_conflict → review_signal; supersession read-model",
    confidence_levels: { high: "Single detail version + shipment match", medium: "API sync", low: "Stale partial detail" },
    when_create_candidate: "removal_missing_units generator on clean gap",
    when_review_signal_only: "Disputed EP / superseded detail",
    when_exclude: "Qty 0 after supersession filter",
    current_implementation_status: "live",
    existing_code_mapping: "amazon_removal_api → removal_missing_units; ORBIT removal_units_unaccounted",
    missing_blocker: "Full supersession auto-exclude in generator not complete",
    implementation_priority: "P0",
  },
  {
    family_key: "removal_shipment_missing_damaged",
    display_name: "Removal shipment missing/damaged",
    lifecycle_states: ["removal_shipment_in_transit", "removal_shipment_lost", "removal_received_short"],
    source_tables_files_api: ["amazon_removal_shipments", "expected_packages (clean)", "packages"],
    required_identifiers: ["tracking_number", "removal_order_id", "fnsku"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: `${QTY.physical_vs_expected}: expected_clean - actual_scanned OR overdue unreceived shipment units`,
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "missing_qty × unit_cost",
    observed_reimbursement_formula: "Reimbursement for lost removal shipment",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "shipment_date OR last_tracking_event",
    deadline_window: "delayed_not_received_days + carrier SLA",
    evidence_requirements: ["Tracking", "Shipment report", "Receive scan proof"],
    trid_edges_required: ["claim_to_shipment", "tracking_number", "shipment_scope", "product_link"],
    claim_readiness_rules: ["Clean EP", "Tracking not received past threshold OR short receive"],
    disputed_source_conflict_handling: "Never use disputed EP for missing qty",
    confidence_levels: { high: "Tracking overdue + clean expected", medium: "Shipment row only", low: "Disputed manifest" },
    when_create_candidate: "delayed_not_received + shipment_discrepancy on clean rows",
    when_review_signal_only: "Disputed overflow conflict",
    when_exclude: "Received in full",
    current_implementation_status: "live",
    existing_code_mapping: "shipment_not_received, shipment_quantity_mismatch; ORBIT removal_shipment_*",
    missing_blocker: "Damage vs missing not split in generator",
    implementation_priority: "P0",
  },
  {
    family_key: "disposed_without_reimbursement",
    display_name: "Disposed/destroyed without reimbursement",
    lifecycle_states: ["inventory_disposed", "inventory_destroyed"],
    source_tables_files_api: ["amazon_inventory_ledger", "amazon_reimbursements"],
    required_identifiers: ["fnsku", "asin", "ledger_reference_id", "reason_code"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "qty = abs(ledger_qty) WHERE reason IN (Dispose, Destroy) AND no reimbursement",
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "qty × unit_cost",
    observed_reimbursement_formula: "SUM(reimbursements) for dispose/destroy events",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "ledger.event_date",
    deadline_window: "Ledger adjustment window",
    evidence_requirements: ["Ledger dispose/destroy line", "No reimbursement match"],
    trid_edges_required: ["ledger_reference", "product_link", "claim_to_reimbursement"],
    claim_readiness_rules: ["Unreimbursed dispose", "Not customer return path"],
    disputed_source_conflict_handling: "Duplicate ledger versions → review_signal",
    confidence_levels: { high: "Ledger + no reimbursement", medium: "Ledger only", low: "Summary ledger not detail" },
    when_create_candidate: "ORBIT destroyed_without_permission",
    when_review_signal_only: "Ambiguous reason code",
    when_exclude: "Authorized dispose",
    current_implementation_status: "partial",
    existing_code_mapping: "ORBIT destroyed_without_permission",
    missing_blocker: "No reimbursement cross-check in generator",
    implementation_priority: "P1",
  },
  {
    family_key: "warehouse_lost_inventory",
    display_name: "Warehouse lost inventory",
    lifecycle_states: ["warehouse_lost", "inventory_missing"],
    source_tables_files_api: ["amazon_inventory_ledger"],
    required_identifiers: ["fnsku", "asin", "ledger_reference_id", "reason_code M/E"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: `${QTY.ledger_negative}: reason warehouse_lost codes`,
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "qty × unit_cost",
    observed_reimbursement_formula: "Reimbursement lost inventory events",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "ledger.event_date",
    deadline_window: "Inventory adjustment claim window",
    evidence_requirements: ["Detail ledger view", "Reconciliation report"],
    trid_edges_required: ["ledger_reference", "product_link"],
    claim_readiness_rules: ["Negative unreconciled qty", "Lost reason code"],
    disputed_source_conflict_handling: "Summary vs detail ledger mismatch → review_signal",
    confidence_levels: { high: "Detail ledger + linkage", medium: "Daily summary", low: "No detail import" },
    when_create_candidate: "ORBIT warehouse_lost + inventory_unreconciled_loss",
    when_review_signal_only: "Summary-only ledger",
    when_exclude: "Already reimbursed",
    current_implementation_status: "live",
    existing_code_mapping: "inventory_ledger generator; ORBIT warehouse_lost",
    missing_blocker: "Detail ledger import gap on some stores",
    implementation_priority: "P1",
  },
  {
    family_key: "warehouse_damaged_inventory",
    display_name: "Warehouse damaged inventory",
    lifecycle_states: ["warehouse_damaged", "inventory_damaged"],
    source_tables_files_api: ["amazon_inventory_ledger"],
    required_identifiers: ["fnsku", "reason_code D"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: `${QTY.ledger_negative}: warehouse damage reason codes`,
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "qty × unit_cost",
    observed_reimbursement_formula: "Damage reimbursement rows",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "ledger.event_date",
    deadline_window: "Adjustment window",
    evidence_requirements: ["Ledger damage event"],
    trid_edges_required: ["ledger_reference", "product_link"],
    claim_readiness_rules: ["Warehouse damage not customer return"],
    disputed_source_conflict_handling: "Same as warehouse_lost",
    confidence_levels: { high: "Detail ledger", medium: "Summary", low: "Stale" },
    when_create_candidate: "ORBIT warehouse_damaged",
    when_review_signal_only: "Ambiguous damage reason",
    when_exclude: "Customer damaged return path",
    current_implementation_status: "live",
    existing_code_mapping: "ORBIT warehouse_damaged; inventory_unreconciled_loss catch-all",
    missing_blocker: "Undifferentiated from generic unreconciled loss",
    implementation_priority: "P2",
  },
  {
    family_key: "inventory_adjustment_error",
    display_name: "Inventory adjustment error",
    lifecycle_states: ["inventory_adjustment", "unreconciled_negative"],
    source_tables_files_api: ["amazon_inventory_ledger", "amazon_reimbursements"],
    required_identifiers: ["fnsku", "ledger_reference_id"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "qty = abs(unreconciled_negative) not classified to lost/damaged/destroy",
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "qty × unit_cost",
    observed_reimbursement_formula: "Matching adjustment reimbursement",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "ledger.event_date",
    deadline_window: "Adjustment window",
    evidence_requirements: ["Before/after snapshot", "Ledger line"],
    trid_edges_required: ["ledger_reference", "product_link"],
    claim_readiness_rules: ["Catch-all after specific families excluded"],
    disputed_source_conflict_handling: "Prefer specific family over catch-all",
    confidence_levels: { high: "Specific reason", medium: "Catch-all", low: "Unknown reason" },
    when_create_candidate: "inventory_unreconciled_loss when no better family",
    when_review_signal_only: "Could be fee or return — manual classify",
    when_exclude: "Classified to another family",
    current_implementation_status: "partial",
    existing_code_mapping: "inventory_unreconciled_loss; ORBIT inventory_adjustment_unreconciled",
    missing_blocker: "Reason taxonomy mapping incomplete",
    implementation_priority: "P2",
  },
  {
    family_key: "inbound_shipment_shortage",
    display_name: "Inbound shipment shortage",
    lifecycle_states: ["inbound_shipment_received", "inbound_shortage"],
    source_tables_files_api: ["amazon_inbound_performance", "amazon_inbound_shipments"],
    required_identifiers: ["fba_shipment_id", "fnsku", "sku"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: `${QTY.inbound_problem}: problem_quantity WHERE received < expected`,
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "shortage_qty × unit_cost",
    observed_reimbursement_formula: "Inbound reimbursement if filed",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "issue_reported_date OR shipment_creation_date",
    deadline_window: "Inbound problem dispute window",
    evidence_requirements: ["Inbound performance report", "Carton IDs"],
    trid_edges_required: ["order_reference", "product_link", "shipment_scope"],
    claim_readiness_rules: ["problem_level qualifies", "problem_qty > 0"],
    disputed_source_conflict_handling: "Carton recount conflict → review_signal",
    confidence_levels: { high: "Performance report + linkage", medium: "Report only", low: "Stale shipment" },
    when_create_candidate: "inbound_shipment generator",
    when_review_signal_only: "Ambiguous carton mapping",
    when_exclude: "Received full",
    current_implementation_status: "live",
    existing_code_mapping: "inbound_shipment_shortage",
    missing_blocker: "Miscount vs shortage not split",
    implementation_priority: "P1",
  },
  {
    family_key: "inbound_receiving_miscount",
    display_name: "Inbound receiving miscount",
    lifecycle_states: ["inbound_received_miscount"],
    source_tables_files_api: ["amazon_inbound_performance", "amazon_inbound_shipments"],
    required_identifiers: ["fba_shipment_id", "fnsku", "carton_id"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "qty = abs(received - expected) WHERE problem_type=miscount NOT shortage",
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "qty × unit_cost",
    observed_reimbursement_formula: "Observed inbound adjustment",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "issue_reported_date",
    deadline_window: "Inbound dispute window",
    evidence_requirements: ["Receiving count evidence", "Performance row"],
    trid_edges_required: ["shipment_scope", "product_link"],
    claim_readiness_rules: ["Miscount not shortage classification"],
    disputed_source_conflict_handling: "Over vs under receive → different claim_reason",
    confidence_levels: { high: "Carton-level", medium: "Shipment-level", low: "Aggregate only" },
    when_create_candidate: "Not separate today — fold into inbound_shipment with reason split",
    when_review_signal_only: "Classification uncertain",
    when_exclude: "Within tolerance",
    current_implementation_status: "partial",
    existing_code_mapping: "Folded into inbound_shipment_shortage",
    missing_blocker: "problem_type taxonomy not split in generator",
    implementation_priority: "P2",
  },
  {
    family_key: "reimbursement_missing",
    display_name: "Reimbursement missing",
    lifecycle_states: ["reimbursement_expected", "reimbursement_not_observed"],
    source_tables_files_api: ["amazon_inventory_ledger", "amazon_reimbursements", "amazon_returns"],
    required_identifiers: ["fnsku", "reimbursement_id OR ledger_reference"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: `${QTY.reimbursement_gap}: expected_units - reimbursed_units`,
    amount_formula: MONEY.cogs_exposure,
    expected_recovery_formula: "gap_qty × unit_cost OR expected_amount from policy table",
    observed_reimbursement_formula: "SUM(amazon_reimbursements.amount) — zero = missing signal",
    actual_loss_formula: MONEY.actual_loss,
    cost_source_requirement: "unit_cost",
    sale_price_display_only: true,
    event_date: "ledger.event_date OR return_date",
    deadline_window: "Reimbursement filing window per event type",
    evidence_requirements: ["Ledger event", "Absence in reimbursements within grace"],
    trid_edges_required: ["ledger_reference", "claim_to_reimbursement", "product_link"],
    claim_readiness_rules: ["Grace period elapsed", "Event type reimbursable"],
    disputed_source_conflict_handling: "Pending reimbursement → review_signal not candidate",
    confidence_levels: { high: "Ledger + linkage + grace elapsed", medium: "Report gap", low: "Incomplete imports" },
    when_create_candidate: "Gap after grace — NOT built (generator gap)",
    when_review_signal_only: "Pending Amazon processing",
    when_exclude: "Non-reimbursable disposition",
    current_implementation_status: "gap",
    existing_code_mapping: "Only reimbursement_reversal (clawbacks) — not missing",
    missing_blocker: "No missing-reimbursement detector",
    implementation_priority: "P0",
  },
  {
    family_key: "reimbursement_partial_incorrect",
    display_name: "Reimbursement partial/incorrect",
    lifecycle_states: ["reimbursement_partial", "reimbursement_clawback"],
    source_tables_files_api: ["amazon_reimbursements", "amazon_inventory_ledger"],
    required_identifiers: ["reimbursement_id", "fnsku", "original_event_id"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "qty = expected_units - reimbursed_units OR abs(clawback_units)",
    amount_formula: MONEY.report_amount,
    expected_recovery_formula: "abs(expected_amount - observed_amount)",
    observed_reimbursement_formula: "amazon_reimbursements.amount (observed lane)",
    actual_loss_formula: "expected_recovery when underpaid; clawback = report amount",
    cost_source_requirement: "report amount primary; COGS for unit gap",
    sale_price_display_only: true,
    event_date: "reimbursement.approval_date OR posting_date",
    deadline_window: "Dispute window for clawback/underpayment",
    evidence_requirements: ["Reimbursement row", "Expected calc worksheet"],
    trid_edges_required: ["claim_to_reimbursement", "ledger_reference", "product_link"],
    claim_readiness_rules: ["Negative reimbursement OR underpayment > tolerance"],
    disputed_source_conflict_handling: "Multi-currency → review_signal",
    confidence_levels: { high: "Exact reimbursement_id match", medium: "Amount delta", low: "Aggregate" },
    when_create_candidate: "reimbursement_reversal for negatives; ORBIT zero_cash_inventory",
    when_review_signal_only: "Partial pay pending",
    when_exclude: "Within rounding tolerance",
    current_implementation_status: "partial",
    existing_code_mapping: "reimbursement_reversal; ORBIT reimbursement_clawback, reimbursement_zero_cash_inventory_only",
    missing_blocker: "Underpayment detection not built",
    implementation_priority: "P1",
  },
  {
    family_key: "settlement_refund_anomaly",
    display_name: "Settlement/refund anomaly",
    lifecycle_states: ["settlement_posted", "refund_anomaly"],
    source_tables_files_api: ["amazon_settlements", "amazon_transactions"],
    required_identifiers: ["settlement_id", "order_id", "sku"],
    product_linkage_requirement: "recommended",
    quantity_formula: "qty = 1 per anomalous settlement line (case grain) OR unit qty if line reports units",
    amount_formula: MONEY.report_amount,
    expected_recovery_formula: "abs(anomaly_amount)",
    observed_reimbursement_formula: "Settlement line IS observed financial event",
    actual_loss_formula: "anomaly_amount when inventory-impacting",
    cost_source_requirement: "report amount; COGS if unit qty known",
    sale_price_display_only: true,
    event_date: "settlement.posted_date",
    deadline_window: "Settlement dispute window",
    evidence_requirements: ["Settlement CSV/API row", "Order context"],
    trid_edges_required: ["claim_to_settlement", "order_reference"],
    claim_readiness_rules: ["Negative refund OR adjustment anomaly"],
    disputed_source_conflict_handling: "Multi-line settlement → one candidate per line",
    confidence_levels: { high: "Settlement + order", medium: "Settlement only", low: "Unparsed line" },
    when_create_candidate: "settlement_refund_review",
    when_review_signal_only: "Unclassified adjustment",
    when_exclude: "Expected fee charge",
    current_implementation_status: "live",
    existing_code_mapping: "settlement_refund_review; ORBIT settlement_*",
    missing_blocker: "Anomaly taxonomy shallow",
    implementation_priority: "P1",
  },
  {
    family_key: "safet_followup",
    display_name: "SAFE-T follow-up",
    lifecycle_states: ["safet_open", "safet_underpaid"],
    source_tables_files_api: ["amazon_safet_claims", "amazon_reimbursements"],
    required_identifiers: ["safet_claim_id", "fnsku", "reimbursement_id"],
    product_linkage_requirement: "recommended",
    quantity_formula: "qty = safet_quantity OR 1 per claim case",
    amount_formula: MONEY.report_amount,
    expected_recovery_formula: "safet_expected_amount - observed_paid",
    observed_reimbursement_formula: "SAFE-T status + linked reimbursement amount",
    actual_loss_formula: "underpayment delta",
    cost_source_requirement: "SAFE-T report amount",
    sale_price_display_only: true,
    event_date: "safet.open_date OR status_date",
    deadline_window: "SAFE-T case follow-up SLA (configurable)",
    evidence_requirements: ["SAFE-T export/API row", "Case status"],
    trid_edges_required: ["safet_reference", "claim_to_reimbursement"],
    claim_readiness_rules: ["Open OR underpaid status", "Source not empty"],
    disputed_source_conflict_handling: "Empty SAFE-T table → unavailable not zero",
    confidence_levels: { high: "SAFE-T row + reimbursement", medium: "SAFE-T only", low: "Empty import" },
    when_create_candidate: "safet_followup generator when rows exist",
    when_review_signal_only: "SAFE-T import empty — connector unavailable",
    when_exclude: "Closed and fully paid",
    current_implementation_status: "partial",
    existing_code_mapping: "safet_followup; ORBIT safet_underpaid_or_open",
    missing_blocker: "SAFE-T data empty on main org — import blocked",
    implementation_priority: "P1",
  },
  {
    family_key: "fba_fee_overcharge",
    display_name: "FBA fee overcharge",
    lifecycle_states: ["fba_fee_charged", "fee_anomaly"],
    source_tables_files_api: ["amazon_fee_preview", "amazon_settlements", "product_packaging_dimensions_current"],
    required_identifiers: ["fnsku", "asin", "fee_type", "settlement_period"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: QTY.fee_units,
    amount_formula: MONEY.fee_delta,
    expected_recovery_formula: "sum(fee_charged - fee_recomputed) per SKU-period",
    observed_reimbursement_formula: "Fee credits in settlements if any",
    actual_loss_formula: "fee_delta when positive",
    cost_source_requirement: "dimension/weight spine + fee schedule — not sale price",
    sale_price_display_only: true,
    event_date: "fee_charge_date OR settlement posted_date",
    deadline_window: "Fee dispute window per fee type",
    evidence_requirements: ["Fee preview", "Dimensions", "Settlement fee lines"],
    trid_edges_required: ["product_link", "claim_to_settlement", "source_evidence"],
    claim_readiness_rules: ["Recomputed fee < charged", "Dimension spine present"],
    disputed_source_conflict_handling: "Missing dimensions → review_signal only",
    confidence_levels: { high: "Dims + fee preview + settlement", medium: "Fee preview only", low: "No dims" },
    when_create_candidate: "NOT built — defer until fee read-model",
    when_review_signal_only: "Fee anomaly detected without recompute",
    when_exclude: "Within Amazon tolerance",
    current_implementation_status: "gap",
    existing_code_mapping: "Audit only — phase-product-dimensions-shipment-fee-claim-audit-v1",
    missing_blocker: "No generator; SellerSnap/fee preview join missing",
    implementation_priority: "P2",
  },
  {
    family_key: "monthly_storage_fee_overcharge",
    display_name: "Monthly storage fee overcharge",
    lifecycle_states: ["storage_fee_charged"],
    source_tables_files_api: ["amazon_monthly_storage_fees", "amazon_settlements"],
    required_identifiers: ["fnsku", "asin", "month", "fulfillment_center"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "qty = cubic_feet OR unit-months (display); case grain = 1 per SKU-month",
    amount_formula: MONEY.fee_delta,
    expected_recovery_formula: "storage_charged - storage_recomputed",
    observed_reimbursement_formula: "Settlement storage credits",
    actual_loss_formula: "fee_delta",
    cost_source_requirement: "volume from product dimensions; not sale price",
    sale_price_display_only: true,
    event_date: "storage_fee.month",
    deadline_window: "Monthly storage dispute window",
    evidence_requirements: ["Storage fee report", "Volume proof"],
    trid_edges_required: ["product_link", "claim_to_settlement"],
    claim_readiness_rules: ["Volume recomputation available"],
    disputed_source_conflict_handling: "Missing volume → review_signal",
    confidence_levels: { high: "Dims + storage report", medium: "Report only", low: "No import" },
    when_create_candidate: "NOT built",
    when_review_signal_only: "Anomaly without recompute",
    when_exclude: "De minimis delta",
    current_implementation_status: "gap",
    existing_code_mapping: "Deferred in fee audit",
    missing_blocker: "No generator; storage_overcharge deferred",
    implementation_priority: "P3",
  },
  {
    family_key: "dimension_weight_fee_issue",
    display_name: "Dimension/weight fee issue",
    lifecycle_states: ["dimension_fee_mismatch"],
    source_tables_files_api: ["product_packaging_dimensions_current", "amazon_fee_preview", "amazon_settlements"],
    required_identifiers: ["fnsku", "asin", "dimension_set_id"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "qty = 1 per SKU dimension dispute case",
    amount_formula: MONEY.fee_delta,
    expected_recovery_formula: "fee_delta from corrected dims vs Amazon charged tier",
    observed_reimbursement_formula: "Fee credits after dimension correction",
    actual_loss_formula: "cumulative fee_delta over lookback",
    cost_source_requirement: "PC04 packaging dimensions (trusted measurement)",
    sale_price_display_only: true,
    event_date: "dimension_change_date OR first_fee_impact_date",
    deadline_window: "Dimension dispute + fee lookback window",
    evidence_requirements: ["Supplier dims", "Carton photos", "Fee preview before/after"],
    trid_edges_required: ["product_link", "source_evidence"],
    claim_readiness_rules: ["PC04 row exists", "Fee tier mismatch proven"],
    disputed_source_conflict_handling: "Conflicting dimension sources → review_signal",
    confidence_levels: { high: "Measured dims + fee preview", medium: "Catalog dims only", low: "No dims" },
    when_create_candidate: "NOT built",
    when_review_signal_only: "Dimension drift signal",
    when_exclude: "Within tier tolerance",
    current_implementation_status: "gap",
    existing_code_mapping: "PC04 table exists; no claim generator",
    missing_blocker: "Fee recompute engine + TRID rules",
    implementation_priority: "P2",
  },
  {
    family_key: "stranded_expired_review_signal",
    display_name: "Stranded/expired review signal",
    lifecycle_states: ["stranded_inventory", "expired_inventory", "unsellable_stranded"],
    source_tables_files_api: ["amazon_stranded_inventory (planned)", "amazon_inventory_ledger", "listing_status"],
    required_identifiers: ["fnsku", "asin", "stranded_reason"],
    product_linkage_requirement: "recommended",
    quantity_formula: QTY.signal_only + "; display_qty = stranded_units from report",
    amount_formula: "expected_recovery = NULL at signal stage; exposure requires cost",
    expected_recovery_formula: "NULL until operator promotes to claim family",
    observed_reimbursement_formula: "N/A at signal stage",
    actual_loss_formula: "NULL until classified",
    cost_source_requirement: "unavailable at signal stage",
    sale_price_display_only: true,
    event_date: "stranded_report_date OR ledger event",
    deadline_window: "N/A — signal only until classified",
    evidence_requirements: ["Stranded report row when available"],
    trid_edges_required: ["product_link", "ledger_reference"],
    claim_readiness_rules: ["Never auto-candidate with qty from stranded alone"],
    disputed_source_conflict_handling: "No stranded table → connector unavailable",
    confidence_levels: { high: "Stranded report + linkage", medium: "Ledger hint", low: "No table" },
    when_create_candidate: "Exclude — operator must pick target family",
    when_review_signal_only: "Always at detection stage",
    when_exclude: "Auto money claims from stranded",
    current_implementation_status: "gap",
    existing_code_mapping: "Named in acquisition checklist only",
    missing_blocker: "No stranded table/import; no generator",
    implementation_priority: "P2",
  },
  {
    family_key: "orbit_fra_fight_list",
    display_name: "ORBIT/FRA fight-list candidate",
    lifecycle_states: ["multi_source_anomaly", "orbit_category_match"],
    source_tables_files_api: [
      "ORBIT workbook (18 categories)",
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
    required_identifiers: ["category_key", "fnsku/sku/asin", "source_row_id per report"],
    product_linkage_requirement: "required_before_trusted_money",
    quantity_formula: "Per ORBIT category rules — clean qty filters applied per underlying family",
    amount_formula: "recovery = units × cogs_unit WHEN cost resolved ELSE reportAmount",
    expected_recovery_formula: "ORBIT formula — never sale_price as COGS",
    observed_reimbursement_formula: "Report amounts from reimbursement/settlement lanes",
    actual_loss_formula: "Same as expected_recovery when COGS-based; else report delta",
    cost_source_requirement: "cogs_overrides → return_items.estimated_value (SellerSnap slot reserved)",
    sale_price_display_only: true,
    event_date: "Per-source event_date from matched report row",
    deadline_window: "Per underlying family window",
    evidence_requirements: ["ORBIT category proof", "Underlying report row", "Cross-source agreement"],
    trid_edges_required: ["All edges for underlying family", "source_evidence", "product_link"],
    claim_readiness_rules: ["category_enabled", "clean qty", "dedupe prefers orbit over scanner twin"],
    disputed_source_conflict_handling: "ORBIT must respect EP/removal disputed gating on quantity",
    confidence_levels: { high: "Multi-report agreement + COGS", medium: "Single report", low: "Workbook stale" },
    when_create_candidate: "orbit_fra generator — 18 categories",
    when_review_signal_only: "Workbook import blocked / category ambiguous",
    when_exclude: "legacy_seed; quarantined rows",
    current_implementation_status: "live",
    existing_code_mapping: "source_kind=orbit_fra; 18 claim_family keys",
    missing_blocker: "XLSX workbook import blocked on staging; COGS feed empty",
    implementation_priority: "P0",
  },
] as const;

/** Derived maps for API/read-model consumers. */
export const QUANTITY_FORMULA_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_ALGORITHM_MATRIX.map((e) => [e.family_key, e.quantity_formula]),
) as Record<ClaimFamilyAlgorithmKey, string>;

export const MONEY_FORMULA_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_ALGORITHM_MATRIX.map((e) => [
    e.family_key,
    {
      amount: e.amount_formula,
      expected_recovery: e.expected_recovery_formula,
      observed_reimbursement: e.observed_reimbursement_formula,
      actual_loss: e.actual_loss_formula,
      cost_source: e.cost_source_requirement,
      sale_price_display_only: e.sale_price_display_only,
    },
  ]),
) as Record<
  ClaimFamilyAlgorithmKey,
  {
    amount: string;
    expected_recovery: string;
    observed_reimbursement: string;
    actual_loss: string;
    cost_source: string;
    sale_price_display_only: boolean;
  }
>;

export const REQUIRED_SOURCES_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_ALGORITHM_MATRIX.map((e) => [e.family_key, e.source_tables_files_api]),
) as Record<ClaimFamilyAlgorithmKey, string[]>;

export const PRODUCT_LINKAGE_REQUIREMENT_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_ALGORITHM_MATRIX.map((e) => [e.family_key, e.product_linkage_requirement]),
) as Record<ClaimFamilyAlgorithmKey, ProductLinkageRequirement>;

export const TRID_EDGE_REQUIREMENT_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_ALGORITHM_MATRIX.map((e) => [e.family_key, e.trid_edges_required]),
) as Record<ClaimFamilyAlgorithmKey, string[]>;

export const EVIDENCE_REQUIREMENT_BY_FAMILY = Object.fromEntries(
  CLAIM_FAMILY_ALGORITHM_MATRIX.map((e) => [e.family_key, e.evidence_requirements]),
) as Record<ClaimFamilyAlgorithmKey, string[]>;

export const CURRENT_SUPPORT_STATUS = Object.fromEntries(
  CLAIM_FAMILY_ALGORITHM_MATRIX.map((e) => [
    e.family_key,
    {
      status: e.current_implementation_status,
      existing_mapping: e.existing_code_mapping,
      missing_blocker: e.missing_blocker,
      priority: e.implementation_priority,
    },
  ]),
) as Record<
  ClaimFamilyAlgorithmKey,
  {
    status: ImplementationStatus;
    existing_mapping: string | null;
    missing_blocker: string;
    priority: ImplementationPriority;
  }
>;

export const IMPLEMENTATION_PRIORITY_ORDER: readonly ClaimFamilyAlgorithmKey[] = [
  "physical_return_scanner_issue",
  "customer_return_not_reimbursed",
  "removal_order_discrepancy",
  "reimbursement_missing",
  "orbit_fra_fight_list",
  "removal_shipment_missing_damaged",
  "empty_box_return",
  "wrong_item_returned",
  "customer_damaged_return",
  "inbound_shipment_shortage",
  "reimbursement_partial_incorrect",
  "settlement_refund_anomaly",
  "safet_followup",
  "refund_without_return",
  "disposed_without_reimbursement",
  "warehouse_lost_inventory",
  "warehouse_damaged_inventory",
  "inventory_adjustment_error",
  "inbound_receiving_miscount",
  "fba_fee_overcharge",
  "dimension_weight_fee_issue",
  "stranded_expired_review_signal",
  "monthly_storage_fee_overcharge",
] as const;

export const FIRST_3_FAMILIES_TO_IMPLEMENT: readonly ClaimFamilyAlgorithmKey[] = [
  "customer_return_not_reimbursed",
  "physical_return_scanner_issue",
  "removal_order_discrepancy",
] as const;

export const SAFE_TO_IMPLEMENT_CLAIM_ALGORITHM_READMODEL = "yes" as const;

export const NEXT_EXACT_PROMPT = `PHASE-CLAIM-FAMILY-ALGORITHM-READMODEL-IMPLEMENT-V1

Mode: read-model API only — expose claim_family_algorithm_matrix via GET /api/claims/center/algorithm-matrix (or extend /sources).

Do not write DB. Do not mutate claim_candidates. Do not implement new generators.

Implement:
1. Wire lib/claims/contracts/claim-family-algorithm-matrix-v1.ts into Claim Center Sources or new Algorithm tab
2. Per-family status badges from CURRENT_SUPPORT_STATUS
3. Smoke script + build
4. Staging verify read-only payload for 23 families

First implementation targets after read-model: customer_return_not_reimbursed generator design dry-run only.` as const;

export function getClaimFamilyEntry(key: ClaimFamilyAlgorithmKey): ClaimFamilyAlgorithmEntry | undefined {
  return CLAIM_FAMILY_ALGORITHM_MATRIX.find((e) => e.family_key === key);
}

export function listFamiliesByPriority(): ClaimFamilyAlgorithmEntry[] {
  const order = new Map(IMPLEMENTATION_PRIORITY_ORDER.map((k, i) => [k, i]));
  return [...CLAIM_FAMILY_ALGORITHM_MATRIX].sort(
    (a, b) => (order.get(a.family_key) ?? 99) - (order.get(b.family_key) ?? 99),
  );
}
