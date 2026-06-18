/**
 * PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE-AND-CLAIM-FAMILY-MAP-V1
 *
 * SERVER-ONLY read-only composer. Probes every claim-relevant source table for
 * existence / row count / latest date, joins the result to the Amazon report
 * registry (importer + SP-API capability) and the V3 claim-family matrix
 * (formulas + availability), and emits the coverage payload consumed by the
 * client-safe contract. NO DB writes, NO Amazon calls, NO AI.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AMAZON_REPORT_REGISTRY,
  type AmazonSyncKind,
} from "@/lib/pipeline/amazon-report-registry";
import {
  CLAIM_FAMILY_MATRIX_V3,
  type ClaimFamilyMatrixV3Entry,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import {
  CLAIM_SOURCE_COVERAGE_V1,
  type ClaimFamilyMapRow,
  type ClaimFamilySupportStatus,
  type ClaimSourceCoveragePayload,
  type LiveSyncPlanRow,
  type SourceConnectionStatus,
  type SourceCoverageRow,
} from "@/lib/claims/center/claim-source-coverage-ui-contract";

const PILOT_FAMILY_KEYS = ["removal_shipment_missing", "removal_order_discrepancy"];

const COGS_RECOVERY = "recovery_value = clean_quantity × approved_cogs_unit (COGS basis, never sale price)";

const REIMB_LOGIC_ORDER_LINKED =
  "Strong: order_id-linked amazon_reimbursements rows (counted). Weak: FNSKU/SKU + ±45d window candidates (shown, excluded). Fees never counted.";
const REIMB_LOGIC_LEDGER =
  "Strong: ledger reference_id + anti-reimbursement (no matching reimbursement row). Weak: FNSKU + ±45d window. Requires Inventory Ledger Detail View.";
const SETTLEMENT_LOGIC =
  "Order_id-linked amazon_settlements rows; only reimbursement/credit transaction_type with amount>0 count — fee lines (FBA Inventory Fee/storage/commission) excluded.";

type SourceCatalogEntry = {
  key: string;
  label: string;
  table: string | null;
  date_columns: string[];
  key_columns: string[];
  external_reference_columns: string[];
  product_identity_columns: string[];
  quantity_columns: string[];
  money_columns: string[];
  sync_kind: AmazonSyncKind | null;
  api_endpoint_exists: boolean;
  live_sp_api_exists: boolean;
  ui_uses_it: boolean;
  claim_families_depending: string[];
  planned: boolean;
  override_based: boolean;
  notes: string;
};

/** The 17 claim-relevant sources requested by the phase, with descriptive (non-queried) column metadata. */
const SOURCE_CATALOG: SourceCatalogEntry[] = [
  {
    key: "amazon_removals",
    label: "Removal Order Detail",
    table: "amazon_removals",
    date_columns: ["request_date", "order_date", "last_updated_date", "created_at"],
    key_columns: ["order_id", "request_id", "removal_order_type"],
    external_reference_columns: ["order_id", "request_id"],
    product_identity_columns: ["fnsku", "sku", "asin"],
    quantity_columns: ["requested_quantity", "cancelled_quantity", "disposed_quantity", "shipped_quantity", "in_process_quantity"],
    money_columns: [],
    sync_kind: "REMOVAL_ORDER",
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["removal_order_discrepancy", "removal_fee_refund_mismatch"],
    planned: false,
    override_based: false,
    notes: "Removal Order Detail flat-file; importer live. SP-API GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA not auto-pulled.",
  },
  {
    key: "amazon_removal_shipments",
    label: "Removal Shipment Detail",
    table: "amazon_removal_shipments",
    date_columns: ["shipment_date", "request_date", "created_at"],
    key_columns: ["order_id", "shipment_id", "tracking_number", "carrier"],
    external_reference_columns: ["order_id", "shipment_id", "tracking_number"],
    product_identity_columns: ["fnsku", "sku"],
    quantity_columns: ["shipped_quantity"],
    money_columns: [],
    sync_kind: "REMOVAL_SHIPMENT",
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["removal_shipment_missing", "removal_damaged_during_removal"],
    planned: false,
    override_based: false,
    notes: "Removal Shipment Detail; post-sync builds expected_packages tree. Tracking/shipment refs power removal claims.",
  },
  {
    key: "amazon_inventory_ledger",
    label: "Inventory Ledger (Detail View)",
    table: "amazon_inventory_ledger",
    date_columns: ["event_date", "date", "created_at"],
    key_columns: ["reference_id", "event_type", "disposition"],
    external_reference_columns: ["reference_id"],
    product_identity_columns: ["fnsku", "sku", "asin"],
    quantity_columns: ["quantity"],
    money_columns: [],
    sync_kind: "INVENTORY_LEDGER",
    api_endpoint_exists: false,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["warehouse_lost_inventory", "warehouse_damaged_inventory", "inventory_adjustment_error", "disposed_without_reimbursement"],
    planned: false,
    override_based: false,
    notes: "Detail View required (reject Daily Summary). Used as ±45d weak candidate source today; not order-linked to pilot removals.",
  },
  {
    key: "amazon_transactions",
    label: "Transaction / Settlement detail",
    table: "amazon_transactions",
    date_columns: ["posted_date", "date_time", "created_at"],
    key_columns: ["transaction_type", "order_id", "settlement_id"],
    external_reference_columns: ["order_id", "settlement_id"],
    product_identity_columns: ["sku", "fnsku"],
    quantity_columns: ["quantity"],
    money_columns: ["amount"],
    sync_kind: "TRANSACTIONS",
    api_endpoint_exists: false,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["settlement_refund_anomaly", "refund_without_return"],
    planned: false,
    override_based: false,
    notes: "0 rows for pilot order ids — pilot settlement data lives in amazon_settlements.",
  },
  {
    key: "amazon_settlements",
    label: "Settlement Flat File V2",
    table: "amazon_settlements",
    date_columns: ["posted_date", "settlement_start_date", "created_at"],
    key_columns: ["settlement_id", "order_id", "transaction_type"],
    external_reference_columns: ["settlement_id", "order_id"],
    product_identity_columns: ["sku", "fnsku"],
    quantity_columns: ["quantity_purchased"],
    money_columns: ["amount_total", "amount"],
    sync_kind: "SETTLEMENT",
    api_endpoint_exists: false,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["settlement_refund_anomaly", "refund_without_return", "fba_fee_overcharge", "monthly_storage_fee_overcharge"],
    planned: false,
    override_based: false,
    notes: "Pilot /x5UTzvZZK order resolves 135 rows — all transaction_type 'FBA Inventory Fee' (fees, not reimbursement credits).",
  },
  {
    key: "amazon_reimbursements",
    label: "FBA Reimbursements",
    table: "amazon_reimbursements",
    date_columns: ["approval_date", "reimbursement_date", "created_at"],
    key_columns: ["reimbursement_id", "reason", "order_id", "case_id"],
    external_reference_columns: ["reimbursement_id", "order_id", "case_id"],
    product_identity_columns: ["fnsku", "sku", "asin"],
    quantity_columns: ["quantity_reimbursed_total", "amount_per_unit"],
    money_columns: ["amount_total"],
    sync_kind: "REIMBURSEMENTS",
    api_endpoint_exists: false,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["missing_reimbursement", "partial_incorrect_reimbursement", "customer_return_not_reimbursed", "warehouse_lost_inventory", "warehouse_damaged_inventory"],
    planned: false,
    override_based: false,
    notes: "0 order-linked rows for pilot orders; 289 FNSKU-level rows exist (Damaged/Lost/CustomerReturn/Reversal) = weak candidates only.",
  },
  {
    key: "amazon_customer_returns",
    label: "FBA Customer Returns",
    table: "amazon_returns",
    date_columns: ["return_date", "created_at"],
    key_columns: ["order_id", "return_id", "lpn", "disposition", "detailed_disposition"],
    external_reference_columns: ["order_id", "return_id", "lpn"],
    product_identity_columns: ["fnsku", "sku", "asin"],
    quantity_columns: ["quantity"],
    money_columns: [],
    sync_kind: "FBA_RETURNS",
    api_endpoint_exists: false,
    live_sp_api_exists: false,
    ui_uses_it: false,
    claim_families_depending: ["customer_return_not_reimbursed", "refund_without_return", "wrong_item_returned", "empty_box_return"],
    planned: false,
    override_based: false,
    notes: "Canonical table amazon_returns (importer target). Alias amazon_customer_returns probed empty in deep census.",
  },
  {
    key: "amazon_reports_repository",
    label: "Reports Repository (raw report metadata)",
    table: "amazon_reports_repository",
    date_columns: ["report_date", "posted_date", "created_at"],
    key_columns: ["report_type", "order_id", "settlement_id"],
    external_reference_columns: ["order_id", "settlement_id"],
    product_identity_columns: ["sku", "fnsku"],
    quantity_columns: ["quantity"],
    money_columns: ["amount"],
    sync_kind: "REPORTS_REPOSITORY",
    api_endpoint_exists: false,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["settlement_refund_anomaly"],
    planned: false,
    override_based: false,
    notes: "Generic raw-report landing; supports order-linked metadata rows for /x5UTzvZZK group.",
  },
  {
    key: "return_items",
    label: "Physical scanned return units",
    table: "return_items",
    date_columns: ["created_at", "scanned_at"],
    key_columns: ["lpn", "tracking_number", "package_id"],
    external_reference_columns: ["lpn", "tracking_number"],
    product_identity_columns: ["fnsku", "sku", "asin"],
    quantity_columns: ["quantity"],
    money_columns: [],
    sync_kind: null,
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["physical_return_scanner_issue", "wrong_item_returned", "empty_box_return"],
    planned: false,
    override_based: false,
    notes: "Physical scanned units only (LOCKED). Not used by current removal pilot families.",
  },
  {
    key: "expected_packages",
    label: "Expected packages (forecast spine)",
    table: "expected_packages",
    date_columns: ["created_at", "updated_at"],
    key_columns: ["id", "order_id", "build_status"],
    external_reference_columns: ["order_id", "tracking_number"],
    product_identity_columns: ["fnsku", "sku", "asin", "resolved_product_id"],
    quantity_columns: ["expected_quantity"],
    money_columns: [],
    sync_kind: null,
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["removal_shipment_missing", "removal_order_discrepancy"],
    planned: false,
    override_based: false,
    notes: "Built from removal shipment tree. Anchors the pilot claim TRID/internal anchor (expected_package_id).",
  },
  {
    key: "claim_candidates",
    label: "Claim candidates",
    table: "claim_candidates",
    date_columns: ["created_at", "updated_at"],
    key_columns: ["id", "claim_family", "source_event_key"],
    external_reference_columns: ["source_event_key"],
    product_identity_columns: ["fnsku", "sku", "asin", "resolved_product_id"],
    quantity_columns: ["clean_quantity", "affected_quantity"],
    money_columns: ["recovery_value"],
    sync_kind: null,
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["ALL"],
    planned: false,
    override_based: false,
    notes: "Generated, never auto-created from OCR/title. claim_family drives all downstream mapping.",
  },
  {
    key: "claim_cases",
    label: "Claim cases",
    table: "claim_cases",
    date_columns: ["created_at", "updated_at"],
    key_columns: ["id", "claim_family", "pilot_case_run_id"],
    external_reference_columns: [],
    product_identity_columns: ["resolved_product_id"],
    quantity_columns: ["clean_quantity"],
    money_columns: ["recovery_value"],
    sync_kind: null,
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["ALL"],
    planned: false,
    override_based: false,
    notes: "Case grouping (1 grouped removal-order case can cover multiple submissions).",
  },
  {
    key: "claim_lines",
    label: "Claim lines",
    table: "claim_lines",
    date_columns: ["created_at"],
    key_columns: ["id", "claim_case_id"],
    external_reference_columns: [],
    product_identity_columns: ["resolved_product_id"],
    quantity_columns: ["clean_quantity"],
    money_columns: ["recovery_value", "approved_cogs_unit"],
    sync_kind: null,
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["ALL"],
    planned: false,
    override_based: false,
    notes: "Per-line COGS × quantity recovery basis.",
  },
  {
    key: "claim_submissions",
    label: "Claim submissions",
    table: "claim_submissions",
    date_columns: ["created_at", "updated_at"],
    key_columns: ["id", "claim_case_id", "amazon_case_id", "filing_status"],
    external_reference_columns: ["amazon_case_id"],
    product_identity_columns: ["resolved_product_id"],
    quantity_columns: ["clean_quantity"],
    money_columns: ["recovery_value", "observed_reimbursement"],
    sync_kind: null,
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["ALL"],
    planned: false,
    override_based: false,
    notes: "10 pilot submissions. amazon_case_id empty (no Amazon submission yet); observed_reimbursement Unknown.",
  },
  {
    key: "claim_reference_edges",
    label: "Claim reference edges",
    table: "claim_reference_edges",
    date_columns: ["created_at"],
    key_columns: ["id", "claim_submission_id", "edge_type", "reference_value"],
    external_reference_columns: ["reference_value"],
    product_identity_columns: ["resolved_product_id"],
    quantity_columns: [],
    money_columns: [],
    sync_kind: null,
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["ALL"],
    planned: false,
    override_based: false,
    notes: "Materialized reference graph (pilot edges). Internal anchors must not be cited as Seller Central proof.",
  },
  {
    key: "product_identifier_map",
    label: "Product identifier map (catalog spine)",
    table: "product_identifier_map",
    date_columns: ["updated_at", "created_at"],
    key_columns: ["fnsku", "sku", "asin", "resolved_product_id"],
    external_reference_columns: [],
    product_identity_columns: ["fnsku", "sku", "asin", "resolved_product_id"],
    quantity_columns: [],
    money_columns: [],
    sync_kind: "PRODUCT_IDENTITY",
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["ALL"],
    planned: false,
    override_based: false,
    notes: "Catalog linkage spine (products + product_identifier_map). Required before trusted money.",
  },
  {
    key: "product_cogs_source",
    label: "Product cost / COGS source",
    table: null,
    date_columns: [],
    key_columns: ["resolved_product_id"],
    external_reference_columns: [],
    product_identity_columns: ["resolved_product_id", "sku"],
    quantity_columns: [],
    money_columns: ["approved_cogs_unit", "unit_cost"],
    sync_kind: null,
    api_endpoint_exists: true,
    live_sp_api_exists: false,
    ui_uses_it: true,
    claim_families_depending: ["ALL"],
    planned: false,
    override_based: true,
    notes: "COGS lives in workspace_settings.module_configs cogs_overrides (JSONB) — no product_cost_snapshots table migrated. Drives recovery_value.",
  },
];

async function probeCount(client: SupabaseClient, table: string): Promise<{ exists: boolean; count: number | null }> {
  // Try org-scoped first, then unscoped (some shared tables lack organization_id).
  const orgId = "00000000-0000-0000-0000-000000000001";
  const scoped = await client.from(table).select("*", { count: "exact", head: true }).eq("organization_id", orgId);
  if (!scoped.error) return { exists: true, count: scoped.count ?? 0 };
  const code = (scoped.error as { code?: string }).code ?? "";
  if (code === "42P01") return { exists: false, count: null }; // undefined table
  const unscoped = await client.from(table).select("*", { count: "exact", head: true });
  if (!unscoped.error) return { exists: true, count: unscoped.count ?? 0 };
  const code2 = (unscoped.error as { code?: string }).code ?? "";
  if (code2 === "42P01") return { exists: false, count: null };
  return { exists: false, count: null };
}

async function probeDateRange(
  client: SupabaseClient,
  table: string,
  candidates: string[],
): Promise<{ col: string | null; latest: string | null; earliest: string | null }> {
  for (const col of candidates) {
    const latestQ = await client.from(table).select(col).not(col, "is", null).order(col, { ascending: false }).limit(1);
    if (latestQ.error) continue;
    const earliestQ = await client.from(table).select(col).not(col, "is", null).order(col, { ascending: true }).limit(1);
    const latestRow = (latestQ.data?.[0] ?? null) as unknown as Record<string, unknown> | null;
    const earliestRow = (earliestQ.data?.[0] ?? null) as unknown as Record<string, unknown> | null;
    const latest = latestRow ? String(latestRow[col] ?? "") || null : null;
    const earliest = earliestRow ? String(earliestRow[col] ?? "") || null : null;
    if (latest || earliest) return { col, latest, earliest };
  }
  return { col: null, latest: null, earliest: null };
}

function connectionStatus(entry: SourceCatalogEntry, exists: boolean, count: number | null): SourceConnectionStatus {
  if (entry.override_based) return "override_based";
  if (entry.planned || entry.table == null) return "planned";
  if (!exists) return "table_missing";
  if ((count ?? 0) === 0) return "loaded_empty";
  return "live_loaded";
}

function splitIdentifiers(ids: string[]): { product: string[]; event: string[] } {
  const productKeys = new Set(["fnsku", "sku", "asin", "lpn", "received_fnsku", "expected_fnsku"]);
  const product: string[] = [];
  const event: string[] = [];
  for (const id of ids) {
    if (productKeys.has(id)) product.push(id);
    else event.push(id);
  }
  return { product, event };
}

function realTables(tables: string[]): string[] {
  return tables.filter((t) => /^amazon_|^expected_packages$|^return_items$|^packages$/.test(t));
}

function reimbursementLogicForFamily(entry: ClaimFamilyMatrixV3Entry): string {
  const tabs = entry.normalized_tables.join(",");
  if (tabs.includes("amazon_inventory_ledger")) return REIMB_LOGIC_LEDGER;
  if (tabs.includes("amazon_reimbursements")) return REIMB_LOGIC_ORDER_LINKED;
  return "Reimbursement not the primary lane for this family (fee/settlement-based).";
}

function settlementLogicForFamily(entry: ClaimFamilyMatrixV3Entry): string {
  if (entry.normalized_tables.some((t) => t.includes("settlement"))) return SETTLEMENT_LOGIC;
  return "No direct settlement lane; reconcile via reimbursement/ledger.";
}

function supportStatusForFamily(
  entry: ClaimFamilyMatrixV3Entry,
  liveTableNames: Set<string>,
): ClaimFamilySupportStatus {
  if (["empty_connector", "planned_sp_api", "unsupported_file"].includes(entry.current_availability)) return "missing";
  const required = realTables(entry.normalized_tables);
  const allLive = required.length > 0 && required.every((t) => liveTableNames.has(t));
  if (entry.current_availability === "live_generator" && allLive) return "complete";
  if (allLive) return "partial";
  return "preview_only";
}

function buildFamilyRow(
  entry: ClaimFamilyMatrixV3Entry,
  liveTableNames: Set<string>,
  observedFamilies: Set<string>,
): ClaimFamilyMapRow {
  const { product, event } = splitIdentifiers(entry.required_identifiers);
  const claimable = entry.classification === "claim_family" || entry.classification === "claim_family_when_source_available";
  return {
    family_key: entry.family_key,
    display_name: entry.display_name,
    classification: entry.classification,
    source_files_required: [...entry.required_reports_api],
    source_tables_required: [...entry.normalized_tables],
    source_references_needed: [...entry.trid_edges_required],
    event_matching_keys: event.length > 0 ? event : ["event_date (±45d window)"],
    product_matching_keys: product.length > 0 ? product : ["resolved_product_id"],
    quantity_logic: entry.quantity_formula,
    cogs_recovery_formula: COGS_RECOVERY,
    reimbursement_matching_logic: reimbursementLogicForFamily(entry),
    settlement_transaction_matching_logic: settlementLogicForFamily(entry),
    support_status: supportStatusForFamily(entry, liveTableNames),
    ui_page: claimable ? "/claim-center/ready-to-file" : "/claim-center/data-coverage",
    api_endpoint: claimable
      ? "/api/claims/center/ready-to-file + /recovery-gap"
      : "/api/claims/center/claim-family-map",
    blocked_reason: entry.blocked_reason,
    priority: entry.implementation_priority,
    is_pilot_family: PILOT_FAMILY_KEYS.includes(entry.family_key),
    observed_in_claim_candidates: observedFamilies.has(entry.family_key),
  };
}

/** Requested family keys → V3 matrix key (null = synthetic). */
const REQUESTED_FAMILY_KEYS: Array<{ req: string; v3: string | null; display?: string }> = [
  { req: "removal_shipment_missing", v3: "removal_shipment_missing" },
  { req: "removal_order_discrepancy", v3: "removal_order_discrepancy" },
  { req: "customer_return_not_reimbursed", v3: "customer_return_not_reimbursed" },
  { req: "refund_without_return", v3: "refund_without_return" },
  { req: "reimbursement_reversal", v3: "partial_incorrect_reimbursement", display: "Reimbursement reversal / clawback" },
  { req: "warehouse_lost_inventory", v3: "warehouse_lost_inventory" },
  { req: "warehouse_damaged_inventory", v3: "warehouse_damaged_inventory" },
  { req: "inbound_shipment_shortage", v3: "inbound_shipment_shortage" },
  { req: "fba_fee_overcharge", v3: "fba_fee_overcharge" },
];

function buildLiveSyncPlan(): LiveSyncPlanRow[] {
  const mk = (
    name: string,
    table: string | null,
    status: string,
    cadence: string,
    backfill: string,
    safe: boolean,
    approval: boolean,
  ): LiveSyncPlanRow => ({
    report_api_name: name,
    source_table: table,
    current_status: status,
    sync_cadence: cadence,
    required_credentials: "SP-API LWA refresh token + role ARN (per store connection)",
    backfill_requirement: backfill,
    failure_handling: "retry w/ backoff; mark raw_report_uploads failed; never partial-commit domain rows",
    audit_log_requirement: "audit_logs row per sync run (org+store scoped); raw_report_uploads lineage",
    safe_to_build_now: safe,
    approval_required: approval,
  });
  return [
    mk("GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA", "amazon_removals", "file importer live; SP-API auto-pull not wired", "daily", "90d on connect", true, false),
    mk("GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA", "amazon_removal_shipments", "file importer live; SP-API auto-pull not wired", "daily", "90d on connect", true, false),
    mk("GET_LEDGER_DETAIL_VIEW_DATA", "amazon_inventory_ledger", "Detail View ingest gate; Daily Summary rejected", "daily", "120d on connect", true, true),
    mk("GET_FBA_REIMBURSEMENTS_DATA", "amazon_reimbursements", "file importer live; order-linked auto-pull missing", "daily", "180d on connect", true, true),
    mk("GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2", "amazon_settlements", "file importer live; settlement schedule auto-pull missing", "per settlement period (14d)", "180d on connect", true, true),
    mk("GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", "amazon_returns", "importer live; pilot returns table empty", "daily", "180d on connect", true, false),
    mk("Finances API listFinancialEvents", "amazon_finances_events", "archive table exists; reconciler not built", "hourly/daily", "as available", false, true),
    mk("Product Fees API getMyFeesEstimate", "fee_estimate_snapshots (planned)", "not implemented", "on-demand per SKU", "n/a", false, true),
    mk("GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA", "amazon_fee_preview", "empty connector", "weekly", "current period", false, true),
  ];
}

export async function composeClaimSourceCoverageV1(
  client: SupabaseClient,
  organizationId: string,
): Promise<ClaimSourceCoveragePayload> {
  // ---- Probe every source ----
  const coverage: SourceCoverageRow[] = [];
  const liveTableNames = new Set<string>();
  for (const entry of SOURCE_CATALOG) {
    let exists = false;
    let count: number | null = null;
    let latest: string | null = null;
    let earliest: string | null = null;
    let dateCol: string | null = null;
    if (entry.table) {
      const c = await probeCount(client, entry.table);
      exists = c.exists;
      count = c.count;
      if (exists && entry.date_columns.length > 0) {
        const d = await probeDateRange(client, entry.table, entry.date_columns);
        dateCol = d.col;
        latest = d.latest;
        earliest = d.earliest;
      }
      if (exists && (count ?? 0) > 0) liveTableNames.add(entry.table);
    }
    const status = connectionStatus(entry, exists, count);
    coverage.push({
      key: entry.key,
      label: entry.label,
      table: entry.table,
      exists,
      row_count: count,
      latest_date: latest,
      date_coverage: earliest && latest ? `${earliest} → ${latest}` : latest ?? null,
      key_columns: entry.key_columns,
      external_reference_columns: entry.external_reference_columns,
      product_identity_columns: entry.product_identity_columns,
      quantity_columns: entry.quantity_columns,
      money_columns: entry.money_columns,
      event_date_columns: dateCol ? [dateCol] : entry.date_columns.slice(0, 1),
      api_endpoint_exists: entry.api_endpoint_exists,
      importer_exists: entry.sync_kind != null && AMAZON_REPORT_REGISTRY[entry.sync_kind]?.sync_target_table != null,
      live_sp_api_exists: entry.live_sp_api_exists,
      ui_uses_it: entry.ui_uses_it,
      connection_status: status,
      claim_families_depending: entry.claim_families_depending,
      notes: entry.notes,
    });
  }

  // ---- Observed claim_family values in claim_candidates (live) ----
  const observedFamilies = new Set<string>();
  const famQ = await client
    .from("claim_candidates")
    .select("claim_family")
    .eq("organization_id", organizationId)
    .not("claim_family", "is", null)
    .limit(5000);
  if (!famQ.error) {
    for (const r of (famQ.data ?? []) as Array<{ claim_family: string | null }>) {
      if (r.claim_family) observedFamilies.add(r.claim_family);
    }
  }

  // ---- Claim family map (requested families + any observed-but-uncovered) ----
  const v3ByKey = new Map(CLAIM_FAMILY_MATRIX_V3.map((e) => [e.family_key, e]));
  const familyMap: ClaimFamilyMapRow[] = [];
  const includedV3Keys = new Set<string>();
  for (const req of REQUESTED_FAMILY_KEYS) {
    const v3 = req.v3 ? v3ByKey.get(req.v3) : undefined;
    if (v3) {
      includedV3Keys.add(v3.family_key);
      const row = buildFamilyRow(v3, liveTableNames, observedFamilies);
      // Re-key/display for synthetic requests (e.g. reimbursement_reversal → partial_incorrect_reimbursement).
      familyMap.push({ ...row, family_key: req.req, display_name: req.display ?? row.display_name });
    } else {
      familyMap.push({
        family_key: req.req,
        display_name: req.display ?? req.req,
        classification: "claim_family_when_source_available",
        source_files_required: ["GET_FBA_REIMBURSEMENTS_DATA"],
        source_tables_required: ["amazon_reimbursements"],
        source_references_needed: ["claim_to_reimbursement", "product_link"],
        event_matching_keys: ["reimbursement_id", "approval_date"],
        product_matching_keys: ["fnsku", "sku"],
        quantity_logic: "claim_quantity = reversed_units",
        cogs_recovery_formula: COGS_RECOVERY,
        reimbursement_matching_logic: REIMB_LOGIC_ORDER_LINKED,
        settlement_transaction_matching_logic: SETTLEMENT_LOGIC,
        support_status: liveTableNames.has("amazon_reimbursements") ? "partial" : "missing",
        ui_page: "/claim-center/data-coverage",
        api_endpoint: "/api/claims/center/claim-family-map",
        blocked_reason: "Reversal detection (Reimbursement_Reversal reason) reconciler not built",
        priority: "P2",
        is_pilot_family: false,
        observed_in_claim_candidates: observedFamilies.has(req.req),
      });
    }
  }
  // Append any observed claim_family in DB not already mapped.
  for (const fam of observedFamilies) {
    if (familyMap.some((f) => f.family_key === fam)) continue;
    const v3 = v3ByKey.get(fam);
    if (v3 && !includedV3Keys.has(fam)) {
      familyMap.push(buildFamilyRow(v3, liveTableNames, observedFamilies));
    } else if (!v3) {
      familyMap.push({
        family_key: fam,
        display_name: fam,
        classification: "unmapped_observed",
        source_files_required: [],
        source_tables_required: [],
        source_references_needed: [],
        event_matching_keys: [],
        product_matching_keys: ["resolved_product_id"],
        quantity_logic: "see claim_candidates.clean_quantity",
        cogs_recovery_formula: COGS_RECOVERY,
        reimbursement_matching_logic: "unmapped — review",
        settlement_transaction_matching_logic: "unmapped — review",
        support_status: "preview_only",
        ui_page: "/claim-center/data-coverage",
        api_endpoint: "/api/claims/center/claim-family-map",
        blocked_reason: "Observed in claim_candidates but not in V3 family matrix",
        priority: "review",
        is_pilot_family: false,
        observed_in_claim_candidates: true,
      });
    }
  }

  // ---- Totals + missing lists ----
  const sources_live_loaded = coverage.filter((c) => c.connection_status === "live_loaded").length;
  const sources_loaded_empty = coverage.filter((c) => c.connection_status === "loaded_empty").length;
  const sources_missing_or_planned = coverage.filter(
    (c) => c.connection_status === "table_missing" || c.connection_status === "planned",
  ).length;

  const missing_files_or_tables: string[] = [];
  for (const c of coverage) {
    if (c.connection_status === "loaded_empty") missing_files_or_tables.push(`${c.label} (${c.table}) — table connected but empty`);
    if (c.connection_status === "table_missing") missing_files_or_tables.push(`${c.label} (${c.table}) — table not migrated`);
    if (c.connection_status === "planned") missing_files_or_tables.push(`${c.label} — planned / override-based, no dedicated table`);
  }

  const missing_api_endpoints = [
    "GET /api/claims/center/source-coverage — NEW (this phase)",
    "GET /api/claims/center/claim-family-map — NEW (this phase)",
    "GET /api/claims/center/recovery-gap — recommended (currently computed client-side from ready-to-file payload)",
    "GET /api/claims/center/reimbursement-matches — recommended (per-claim strong/weak match rows)",
    "GET /api/claims/center/source-events — recommended (raw event rows behind a claim)",
    "GET /api/claims/center/report-sync-status — recommended (raw_report_uploads + audit_logs sync health)",
  ];

  const family_complete = familyMap.filter((f) => f.support_status === "complete").length;
  const family_partial = familyMap.filter((f) => f.support_status === "partial").length;
  const family_preview_or_missing = familyMap.filter(
    (f) => f.support_status === "preview_only" || f.support_status === "missing",
  ).length;

  const highest_priority_next_builds = [
    "P0: order-linked reimbursement auto-match (GET_FBA_REIMBURSEMENTS_DATA scheduled sync) to turn Unknown → confirmed not/partially/fully reimbursed",
    "P1: GET /api/claims/center/recovery-gap + /reimbursement-matches read APIs (move recovery gap server-side, authoritative)",
    "P1: Inventory Ledger Detail View ingest worker (unlocks warehouse_lost/damaged + disposed families)",
    "P2: FBA Customer Returns sync (amazon_returns) for customer_return_not_reimbursed + refund_without_return",
    "P2: Fee Preview / Product Fees API for fba_fee_overcharge + dimension_weight_fee_issue",
  ];

  return {
    version: CLAIM_SOURCE_COVERAGE_V1,
    generated_at: new Date().toISOString(),
    organization_id: organizationId,
    source_coverage_matrix: coverage,
    claim_family_map: familyMap,
    live_sync_plan: buildLiveSyncPlan(),
    totals: {
      sources_total: coverage.length,
      sources_live_loaded,
      sources_loaded_empty,
      sources_missing_or_planned,
      families_total: familyMap.length,
      families_complete: family_complete,
      families_partial: family_partial,
      families_preview_or_missing: family_preview_or_missing,
    },
    missing_files_or_tables,
    missing_api_endpoints,
    highest_priority_next_builds,
  };
}
