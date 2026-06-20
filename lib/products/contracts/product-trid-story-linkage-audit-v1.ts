/**
 * PHASE-PRODUCT-TRID-STORY-LINKAGE-AUDIT-AND-LAYER-V1
 * Read-only contract: product identity audit spec, TRID/external-reference model,
 * Seller Central proof vs internal-only reference matrix, and the incoming
 * SP-API/report mapping rule.
 *
 * Client-safe — pure data + types. No DB access. No claim mutation. No new tables.
 * Reuses the existing catalog spine (products + product_identifier_map) and the
 * existing claim_reference_edges / TRID edge-requirements vocabulary.
 */

export const PRODUCT_TRID_STORY_LINKAGE_AUDIT_V1 = {
  phase: "PHASE-PRODUCT-TRID-STORY-LINKAGE-AUDIT-AND-LAYER-V1",
  mode: "audit_and_build_plan",
  read_only: true,
  no_db_writes: true,
  no_new_tables: true,
  pilotCaseRunId: "pilot-20260615T190000Z",
  intakeRunId: "a8a892fe-37d5-4d74-9ea2-02af8fd095ce",
  catalog_spine: ["products", "product_identifier_map"],
  resolver: "lib/search/product-identifier-resolve.ts (resolveProductIdentifier) — never OCR/title auto-create",
} as const;

/** Product identity fields audited per source row. */
export const PRODUCT_IDENTITY_FIELDS = [
  "sku",
  "fnsku",
  "asin",
  "upc",
  "product_id",
  "product_listing_id",
  "marketplace_sku",
  "internal_sku",
  "title",
  "image",
  "category",
  "vendor",
] as const;
export type ProductIdentityField = (typeof PRODUCT_IDENTITY_FIELDS)[number];

/**
 * Per source-table identity spec.
 * `identity_columns` = real columns present on the table that carry product identity.
 * `resolved_column` = canonical resolved FK column if the table has been wired to the spine.
 * `status_column` = identifier_resolution_status column if present.
 */
export type SourceIdentitySpec = {
  source_table: string;
  exists: boolean;
  identity_columns: string[];
  resolved_column: string | null;
  status_column: string | null;
  confidence_column: string | null;
  /** Identity fields the table structurally cannot carry (informational). */
  structurally_absent: ProductIdentityField[];
  notes: string;
};

export const SOURCE_IDENTITY_SPECS: readonly SourceIdentitySpec[] = [
  {
    source_table: "amazon_removals",
    exists: true,
    identity_columns: ["sku", "fnsku"],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["asin", "upc", "product_id", "product_listing_id"],
    notes: "Removal orders. SKU+FNSKU only; resolve via product_identifier_map bridge (not persisted).",
  },
  {
    source_table: "amazon_removal_shipments",
    exists: true,
    identity_columns: ["sku", "fnsku"],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["asin", "upc", "product_id"],
    notes: "Removal shipment grain; carries tracking_number + order_id references.",
  },
  {
    source_table: "expected_packages",
    exists: true,
    identity_columns: ["sku"],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["fnsku", "asin", "upc", "product_id"],
    notes: "Derived from removals/shipments; SKU on base table, FNSKU via source linkage only.",
  },
  {
    source_table: "packages",
    exists: true,
    identity_columns: [],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["sku", "fnsku", "asin", "upc", "product_id"],
    notes: "Physical package envelope — product identity lives in child return_items / manifest_data.",
  },
  {
    source_table: "return_items",
    exists: true,
    identity_columns: ["sku", "fnsku", "asin", "product_identifier", "product_id"],
    resolved_column: "resolved_product_id",
    status_column: "identifier_resolution_status",
    confidence_column: "identifier_resolution_confidence",
    structurally_absent: ["product_listing_id"],
    notes: "Richest identity table; already wired to resolver (resolved_product_id + status).",
  },
  {
    source_table: "amazon_inventory_ledger",
    exists: true,
    identity_columns: ["sku", "fnsku", "asin"],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["upc", "product_id", "product_listing_id"],
    notes: "Ledger events; reference_id (often order_id) joins financial/removal lanes.",
  },
  {
    source_table: "amazon_settlements",
    exists: true,
    identity_columns: ["sku"],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["fnsku", "asin", "upc", "product_id"],
    notes: "SKU present on detail rows; settlement_id + order_id are the proof references.",
  },
  {
    source_table: "amazon_transactions",
    exists: true,
    identity_columns: ["sku"],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["fnsku", "asin", "upc", "product_id"],
    notes: "SKU + order_id + settlement_id; transaction_type classifies the event.",
  },
  {
    source_table: "amazon_reimbursements",
    exists: true,
    identity_columns: ["sku"],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["product_listing_id"],
    notes: "SKU + reimbursement_id + order_id; fnsku/asin may live in raw_data only.",
  },
  {
    source_table: "amazon_returns",
    exists: true,
    identity_columns: ["sku", "fnsku", "asin"],
    resolved_column: "resolved_product_id",
    status_column: "identifier_resolution_status",
    confidence_column: "identifier_resolution_confidence",
    structurally_absent: ["upc", "product_listing_id"],
    notes: "Canonical FBA customer-returns table (NOT customer_returns/amazon_customer_returns). Resolver-wired.",
  },
  {
    source_table: "amazon_reports_repository",
    exists: true,
    identity_columns: ["sku"],
    resolved_column: null,
    status_column: null,
    confidence_column: null,
    structurally_absent: ["fnsku", "asin", "upc", "product_id"],
    notes: "Flat report ledger; SKU + order_id + settlement_id; transaction_type classifies.",
  },
] as const;

/** customer_returns requested in spec but does not exist — canonical table is amazon_returns. */
export const NON_EXISTENT_SOURCE_TABLES = [
  {
    requested: "customer_returns",
    status: "absent",
    canonical_substitute: "amazon_returns",
    note: "No customer_returns / amazon_customer_returns table; amazon_customer_returns alias probed empty.",
  },
  {
    requested: "inbound/performance sources",
    status: "deferred",
    canonical_substitute: "amazon_inbound_shipment_items / inbound performance reports (not yet imported)",
    note: "Inbound/performance import workers exist (reports-api) but pilot has no inbound claim rows; audited as 0 when present.",
  },
] as const;

/** Reference classification for the TRID/external-reference model (Part 2). */
export type ReferenceProofClass = "seller_central_proof" | "internal_only" | "hybrid";

export type TridReferenceModelEntry = {
  reference: string;
  source_tables: string[];
  target_entity: string;
  claim_family_relevance: string;
  proof_class: ReferenceProofClass;
  /** true = usable as Seller Central proof in a claim narrative. */
  seller_central_proof: boolean;
  internal_only: boolean;
  default_confidence: number;
  notes: string;
};

export const TRID_REFERENCE_MODEL: readonly TridReferenceModelEntry[] = [
  {
    reference: "order_id",
    source_tables: [
      "return_items",
      "amazon_returns",
      "amazon_removals",
      "amazon_removal_shipments",
      "amazon_settlements",
      "amazon_transactions",
      "amazon_reimbursements",
      "amazon_reports_repository",
      "packages",
    ],
    target_entity: "amazon_order / removal_order",
    claim_family_relevance: "customer_return_not_reimbursed, refund_without_return, settlement anomalies",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 0.9,
    notes: "Amazon-issued. Financial join spine. Ambiguous when one order spans multiple events.",
  },
  {
    reference: "shipment_id",
    source_tables: ["amazon_removal_shipments", "expected_packages"],
    target_entity: "removal_shipment / inbound_shipment",
    claim_family_relevance: "removal_shipment_missing, inbound discrepancies",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 0.9,
    notes: "Amazon shipment grain; not interchangeable with package_id.",
  },
  {
    reference: "removal_order_id",
    source_tables: ["amazon_removals", "expected_packages"],
    target_entity: "removal_order",
    claim_family_relevance: "removal_order_discrepancy",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 1.0,
    notes: "Stored as order_id on amazon_removals. Strong proof.",
  },
  {
    reference: "removal_shipment_id",
    source_tables: ["amazon_removal_shipments"],
    target_entity: "removal_shipment",
    claim_family_relevance: "removal_shipment_missing",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 0.9,
    notes: "Anchored by tracking_number; aggregate per candidate-order when multi-tracking.",
  },
  {
    reference: "tracking_number",
    source_tables: ["packages", "amazon_removal_shipments", "expected_packages", "return_items"],
    target_entity: "carrier_shipment",
    claim_family_relevance: "physical_return_scanner_issue, removal_shipment_missing",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 1.0,
    notes: "Carrier-issued; corroborates physical movement. return_items.lpn is the FBA return label.",
  },
  {
    reference: "reimbursement_id",
    source_tables: ["amazon_reimbursements"],
    target_entity: "amazon_reimbursement",
    claim_family_relevance: "missing_reimbursement, partial_incorrect_reimbursement",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 1.0,
    notes: "Expected-recovery proof; observed_reimbursement is a SEPARATE lane.",
  },
  {
    reference: "settlement_id",
    source_tables: ["amazon_settlements", "amazon_transactions", "amazon_reports_repository"],
    target_entity: "settlement_report",
    claim_family_relevance: "settlement_refund_anomaly, partial_incorrect_reimbursement",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 0.9,
    notes: "Amazon settlement report id; proof of payout/deduction.",
  },
  {
    reference: "transaction_id",
    source_tables: ["amazon_transactions"],
    target_entity: "settlement_transaction_line",
    claim_family_relevance: "settlement_refund_anomaly",
    proof_class: "hybrid",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 0.8,
    notes: "Some sources expose explicit transaction id; else row identity + settlement_id + order_id.",
  },
  {
    reference: "adjustment_id",
    source_tables: ["amazon_reimbursements (raw_data)", "amazon_reports_repository (raw_data)"],
    target_entity: "inventory_adjustment",
    claim_family_relevance: "warehouse_lost_inventory, warehouse_damaged_inventory",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 0.7,
    notes: "Not a first-class column; lives in raw_data/reason_code. Extract on normalize, never invent.",
  },
  {
    reference: "event_id",
    source_tables: ["amazon_finances_events", "amazon_inventory_ledger (reference_id)"],
    target_entity: "financial_event / ledger_event",
    claim_family_relevance: "finances_api_event_mismatch",
    proof_class: "hybrid",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 0.85,
    notes: "Citation layer; not claim-ready alone. ledger reference_id often equals order_id.",
  },
  {
    reference: "return_id",
    source_tables: ["amazon_returns (raw_data / lpn)", "return_items (lpn, rma_number)"],
    target_entity: "customer_return",
    claim_family_relevance: "customer_return_not_reimbursed",
    proof_class: "hybrid",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 0.8,
    notes: "Amazon return id usually in raw_data; lpn/rma_number are the durable proof keys.",
  },
  {
    reference: "package_id",
    source_tables: ["packages"],
    target_entity: "physical_package (internal)",
    claim_family_relevance: "physical_return_scanner_issue",
    proof_class: "internal_only",
    seller_central_proof: false,
    internal_only: true,
    default_confidence: 1.0,
    notes: "Our UUID / package_code. Operational scope only — NEVER cited as Seller Central proof.",
  },
  {
    reference: "expected_package_id",
    source_tables: ["expected_packages"],
    target_entity: "expected_package (internal)",
    claim_family_relevance: "removal reconciliation",
    proof_class: "internal_only",
    seller_central_proof: false,
    internal_only: true,
    default_confidence: 1.0,
    notes: "Internal derived id; primary TRID anchor for pilot but NOT external proof.",
  },
  {
    reference: "product_id / resolved_product_id",
    source_tables: ["products", "return_items", "amazon_returns"],
    target_entity: "catalog product (internal)",
    claim_family_relevance: "all product-linked families",
    proof_class: "internal_only",
    seller_central_proof: false,
    internal_only: true,
    default_confidence: 1.0,
    notes: "Canonical products.id. Internal identity only; Amazon proof is sku/fnsku/asin.",
  },
  {
    reference: "amazon_case_id",
    source_tables: ["amazon_reimbursements (case_id, raw_data)", "claim_submissions.submission_id"],
    target_entity: "seller_central_case",
    claim_family_relevance: "filed claim follow-up",
    proof_class: "seller_central_proof",
    seller_central_proof: true,
    internal_only: false,
    default_confidence: 1.0,
    notes: "Amazon case id; pilot submissions have submission_id NULL until filed. Never fabricate.",
  },
] as const;

/** Amazon product identifiers that ARE valid Seller Central proof (vs internal UUIDs). */
export const SELLER_CENTRAL_PROOF_IDENTIFIERS = ["sku", "fnsku", "asin", "lpn", "rma_number"] as const;
export const INTERNAL_ONLY_IDENTIFIERS = [
  "product_id",
  "resolved_product_id",
  "resolved_catalog_product_id",
  "package_id",
  "expected_package_id",
  "pallet_id",
  "upload_id",
  "source_staging_id",
  "claim_candidate_id",
] as const;

/** Part 4 — Incoming SP-API / report mapping rule (deterministic, no AI). */
export const INCOMING_API_MAPPING_RULE = {
  version: "incoming-api-mapping-rule-v1",
  steps: [
    "1. Store raw row verbatim (raw_data / raw_row jsonb) before any normalization.",
    "2. Normalize the source row into typed columns for its canonical table (no value invention).",
    "3. Resolve product identity via resolveProductIdentifier (UPC→SKU→FNSKU→ASIN order); never OCR/title.",
    "4. Attach canonical product_id (resolved_product_id) ONLY when resolver status = resolved (single match).",
    "5. If multiple product matches → mark identifier_resolution_status = ambiguous; do NOT attach product_id.",
    "6. If no identity fields or no match → mark orphan/unresolved; keep row, flag for review.",
    "7. Attach reference edges (order_id, tracking_number, removal_*, settlement_id, reimbursement_id) only when deterministic; preserve ambiguity_group_key when >1 candidate.",
    "8. Never invent a TRID/reference; absent → leave null, do not synthesize.",
    "9. Never use an internal UUID (product_id, package_id, expected_package_id) as Seller Central proof.",
    "10. Persist both the raw row and the normalized event; resolution is additive and reversible.",
  ],
  determinism_guarantee:
    "resolver + reference joins are set-based and idempotent (ON CONFLICT DO NOTHING on claim_reference_edges natural key).",
  forbidden: [
    "auto-create products from title/OCR",
    "use sale price as cost basis",
    "use internal UUID as external proof",
    "synthesize missing reference ids",
    "AI/GPT as source of truth",
  ],
} as const;

export type ProductIdentitySourceAudit = {
  source_table: string;
  exists: boolean;
  total_org_rows: number;
  identity_field_present: Record<string, number | "column_absent">;
  mapped_to_canonical_product: number | "n/a";
  ambiguous_product_match: number | "n/a";
  orphan_source_rows: number;
  stale_product_links: number | "n/a";
  missing_asin_count: number | "column_absent";
  missing_fnsku_count: number | "column_absent";
  missing_sku_count: number | "column_absent";
  notes: string;
};

export type ProductStoryBlocker = {
  product_key: string;
  blocker: string;
  missing_edge_or_field: string;
};

export type ProductStoryPreview = {
  fnsku: string;
  sku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  product_title: string | null;
  identity_status: "resolved" | "ambiguous" | "unresolved";
  latest_sale_net: number | null;
  cogs_internal_cost: number | null;
  removals_count: number;
  received_scanned_status: string;
  inventory_ledger_events: number;
  settlements_orders_count: number;
  reimbursements_count: number;
  customer_returns_count: number;
  claim_candidates_by_family: Record<string, number>;
  open_amount: number | null;
  recovered_amount: number | null;
  missing_links: string[];
};

export type ProductTridStoryLinkageAuditResult = {
  phase: string;
  run_id: string;
  db_ref: string;
  read_only: true;
  product_linkage_status: "healthy" | "partial" | "blocked";
  product_identity_matrix_by_source: ProductIdentitySourceAudit[];
  orphan_rows_by_source: Record<string, number>;
  ambiguous_matches_by_source: Record<string, number | "n/a">;
  trid_reference_model: typeof TRID_REFERENCE_MODEL;
  seller_central_proof_reference_matrix: TridReferenceModelEntry[];
  internal_only_reference_matrix: TridReferenceModelEntry[];
  product_story_preview_matrix: ProductStoryPreview[];
  current_pilot_product_story_coverage: string;
  missing_linkage_blockers: ProductStoryBlocker[];
  recommended_reuse_existing_tables: "yes" | "no";
  new_tables_needed: "yes" | "no";
  proposed_schema_if_needed: string | null;
  approval_required: "yes" | "no";
  no_claim_submission_mutation_verification: boolean;
  no_amazon_submission_verification: boolean;
  no_scanner_change_verification: boolean;
  build_result: string;
  smoke_result: string;
  next_build_result: string;
  SAFE_PRODUCT_TRID_STORY_LAYER_READY: "yes" | "no";
  SAFE_TO_BUILD_FAMILY_CLAIM_GENERATORS: "yes" | "no";
  NEXT_PROMPT: string;
};

export function splitProofMatrices(): {
  seller_central: TridReferenceModelEntry[];
  internal_only: TridReferenceModelEntry[];
} {
  return {
    seller_central: TRID_REFERENCE_MODEL.filter((r) => r.seller_central_proof),
    internal_only: TRID_REFERENCE_MODEL.filter((r) => r.internal_only && !r.seller_central_proof),
  };
}
