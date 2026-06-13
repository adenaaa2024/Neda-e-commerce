/**
 * PHASE-PRODUCT-AMAZON-LIFECYCLE-QUANTITY-READMODEL-CONTRACT-V1
 * Read-only architecture + API/read-model contract. No DB writes.
 *
 *   npx tsx scripts/phase-product-amazon-lifecycle-quantity-readmodel-contract-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-product-amazon-lifecycle-quantity-readmodel-contract-v1";

const SAMPLES = {
  removal_fnsku: "X004LKS4VD",
  tracking: "387003587",
  spine_fnsku: "B0000B11UX",
  spine_product_id: "8beddd08-4133-48fb-abc1-279e61af8caf",
};

type Row = Record<string, unknown>;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPg(): Promise<pg.Client> {
  const url =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) throw new Error(`BLOCKED: must target staging ref ${STAGING_REF}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return r.rows.length > 0;
}

async function tableCount(c: pg.Client, table: string, orgOnly = true): Promise<number | null> {
  if (!(await tableExists(c, table))) return null;
  const r = await c.query(
    orgOnly
      ? `SELECT count(*)::int AS n FROM public.${table} WHERE organization_id = $1::uuid`
      : `SELECT count(*)::int AS n FROM public.${table}`,
    orgOnly ? [ORG] : [],
  );
  return Number((r.rows[0] as Row).n ?? 0);
}

async function lastImportAt(c: pg.Client, table: string): Promise<string | null> {
  if (!(await tableExists(c, table))) return null;
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  const colSet = new Set(cols.rows.map((x: { column_name: string }) => x.column_name));
  const dateCol = colSet.has("updated_at")
    ? "updated_at"
    : colSet.has("created_at")
      ? "created_at"
      : null;
  if (!dateCol) return null;
  const r = await c.query(
    `SELECT max(${dateCol})::text AS m FROM public.${table} WHERE organization_id = $1::uuid`,
    [ORG],
  );
  return (r.rows[0] as Row).m as string | null;
}

function lifecycleQuantityContract(): Row[] {
  return [
    {
      state_key: "sent_to_amazon",
      label: "Sent to Amazon",
      source_table: "amazon_inbound_performance",
      source_file_api: "Inbound Performance report / SP-API FBA Inbound Shipment",
      quantity_field: "expected_quantity (inbound working+shipped rollup from amazon_fba_inventory.inbound_shipped as snapshot adjunct)",
      event_date_field: "shipment_creation_date",
      reference_id_type: "fba_shipment_id",
      confidence_default: "medium",
      freshness_class: "event_ledger",
      source_availability: "partial",
      safe_for_display: "yes_with_badge",
      safe_for_claim_candidate: "no_alone",
      human_review: "when expected vs shipped mismatch across sources",
      aggregation: "sum by product_id + fba_shipment_id; do not net with received",
      notes: "Inbound sent is shipment-scoped; FBA inventory snapshot inbound_shipped is point-in-time not cumulative sent",
    },
    {
      state_key: "received_by_amazon",
      label: "Received by Amazon",
      source_table: "amazon_inbound_performance",
      source_file_api: "Inbound Performance report",
      quantity_field: "received_quantity",
      event_date_field: "issue_reported_date",
      reference_id_type: "fba_shipment_id",
      confidence_default: "high",
      freshness_class: "event_ledger",
      source_availability: "partial",
      safe_for_display: "yes",
      safe_for_claim_candidate: "no_alone",
      human_review: "when received < expected on same shipment",
      aggregation: "sum received_quantity per shipment; shortage = expected - received",
    },
    {
      state_key: "available_fba",
      label: "Available at Amazon (FBA)",
      source_table: "amazon_fba_inventory / amazon_manage_fba_inventory",
      source_file_api: "FBA Inventory Health / RESTOCK_INVENTORY report",
      quantity_field: "available / fulfillable_quantity",
      event_date_field: "snapshot_date",
      reference_id_type: "fnsku",
      confidence_default: "high",
      freshness_class: "snapshot",
      source_availability: "current_if_fresh",
      safe_for_display: "yes",
      safe_for_claim_candidate: "no",
      human_review: "when snapshot stale >45d",
      aggregation: "latest snapshot row per fnsku; not additive across dates",
    },
    {
      state_key: "reserved_fba",
      label: "Reserved FBA",
      source_table: "amazon_fba_inventory / amazon_reserved_inventory / amazon_manage_fba_inventory",
      source_file_api: "FBA Inventory Health / Reserved Inventory",
      quantity_field: "total_reserved_quantity / reserved_fc_transfer + reserved_fc_processing + reserved_customer_order",
      event_date_field: "snapshot_date",
      reference_id_type: "fnsku",
      confidence_default: "high",
      freshness_class: "snapshot",
      source_availability: "partial",
      safe_for_display: "yes",
      safe_for_claim_candidate: "no",
      human_review: "when reserved + available != total per Amazon docs",
      aggregation: "latest snapshot only",
    },
    {
      state_key: "warehouse_internal",
      label: "Warehouse / internal stock",
      source_table: "return_items + packages",
      source_file_api: "Scanner operator mobile (physical scans)",
      quantity_field: "scanned_quantity (1 per return_item row)",
      event_date_field: "created_at",
      reference_id_type: "return_item_id / package_id",
      confidence_default: "high",
      freshness_class: "operational_current",
      source_availability: "current",
      safe_for_display: "yes",
      safe_for_claim_candidate: "yes_with_linkage",
      human_review: "when product_id unresolved",
      aggregation: "count active return_items in warehouse states; not Amazon FBA",
    },
    {
      state_key: "sold",
      label: "Sold",
      source_table: "amazon_settlements / amazon_transactions / amazon_all_orders",
      source_file_api: "SETTLEMENT / TRANSACTIONS / ALL_ORDERS",
      quantity_field: "quantity (positive order/shipment lines)",
      event_date_field: "posted_date / purchase_date",
      reference_id_type: "order_id",
      confidence_default: "medium",
      freshness_class: "event_ledger",
      source_availability: "current",
      safe_for_display: "yes",
      safe_for_claim_candidate: "no_alone",
      human_review: "when settlement qty disagrees with orders",
      aggregation: "sum sale qty by product_id; exclude refunds from sold bucket",
    },
    {
      state_key: "refunded_or_canceled",
      label: "Canceled / refunded",
      source_table: "amazon_settlements / amazon_transactions",
      source_file_api: "SETTLEMENT / TRANSACTIONS refund lines",
      quantity_field: "quantity (refund/adjustment lines)",
      event_date_field: "posted_date",
      reference_id_type: "order_id",
      confidence_default: "medium",
      freshness_class: "event_ledger",
      source_availability: "current",
      safe_for_display: "yes",
      safe_for_claim_candidate: "partial",
      human_review: "when refund without matching sale line",
      aggregation: "sum refund qty; separate from sold",
    },
    {
      state_key: "customer_returned",
      label: "Customer returned (FBA)",
      source_table: "amazon_returns",
      source_file_api: "FBA Customer Returns report",
      quantity_field: "quantity (or 1 per row if null)",
      event_date_field: "return_date",
      reference_id_type: "order_id / lpn",
      confidence_default: "high",
      freshness_class: "event_ledger",
      source_availability: "import_only",
      safe_for_display: "yes",
      safe_for_claim_candidate: "no_until_generator",
      human_review: "disposition sellable vs unsellable",
      aggregation: "sum by product_id; distinct from scanner physical_return",
    },
    {
      state_key: "removed_created",
      label: "Removal created",
      source_table: "amazon_removals",
      source_file_api: "REMOVAL_ORDER report / Removal API",
      quantity_field: "requested_quantity / shipped_quantity / disposed_quantity columns per row type",
      event_date_field: "order_date",
      reference_id_type: "order_id (removal_order_id)",
      confidence_default: "high",
      freshness_class: "event_ledger",
      source_availability: "current",
      safe_for_display: "yes",
      safe_for_claim_candidate: "yes",
      human_review: "multi-line same order_id",
      aggregation: "sum requested_quantity by removal order + fnsku",
    },
    {
      state_key: "removed_shipped",
      label: "Removal shipped",
      source_table: "amazon_removal_shipments / expected_packages",
      source_file_api: "REMOVAL_SHIPMENT + expected rebuild",
      quantity_field: "shipped_quantity / expected_scan_quantity",
      event_date_field: "shipment_date",
      reference_id_type: "tracking_number / order_id",
      confidence_default: "high",
      freshness_class: "event_ledger",
      source_availability: "current",
      safe_for_display: "yes_excluding_disputed",
      safe_for_claim_candidate: "yes_excluding_disputed",
      human_review: "shipment_overflow_conflict on EP (387003587 pattern)",
      aggregation: "sum shipped_quantity; exclude EP rows with shipment_overflow_conflict from primary total",
    },
    {
      state_key: "disposed",
      label: "Disposed",
      source_table: "amazon_removals / amazon_inventory_ledger",
      source_file_api: "REMOVAL_ORDER + INVENTORY_LEDGER Disposal events",
      quantity_field: "disposed_quantity / quantity where event_type or reason indicates disposal",
      event_date_field: "order_date / event_date",
      reference_id_type: "removal_order_id / ledger reference_id",
      confidence_default: "medium",
      freshness_class: "event_ledger",
      source_availability: "partial",
      safe_for_display: "yes_with_badge",
      safe_for_claim_candidate: "partial",
      human_review: "ledger reason_code mapping required",
      aggregation: "sum disposal events; corroborate removal row when both exist",
    },
    {
      state_key: "damaged",
      label: "Damaged",
      source_table: "return_items / amazon_inventory_ledger / amazon_returns",
      source_file_api: "Scanner conditions + INVENTORY_LEDGER + FBA_RETURNS disposition",
      quantity_field: "scanned_quantity / quantity / unreconciled_quantity",
      event_date_field: "created_at / event_date / return_date",
      reference_id_type: "return_item_id / ledger reference_id",
      confidence_default: "medium",
      freshness_class: "mixed",
      source_availability: "partial",
      safe_for_display: "yes_with_source_badge",
      safe_for_claim_candidate: "yes_scanner_high_ledger_medium",
      human_review: "when scanner vs ledger disagree",
      aggregation: "do not merge scanner + ledger without dedupe key",
    },
    {
      state_key: "lost",
      label: "Lost",
      source_table: "amazon_inventory_ledger",
      source_file_api: "INVENTORY_LEDGER (M* reason codes, Adjustments)",
      quantity_field: "unreconciled_quantity / abs(quantity) on loss events",
      event_date_field: "event_date",
      reference_id_type: "reference_id",
      confidence_default: "high",
      freshness_class: "event_ledger",
      source_availability: "current",
      safe_for_display: "yes",
      safe_for_claim_candidate: "yes",
      human_review: "when resolved_product_id missing",
      aggregation: "sum unreconciled loss lines not yet reimbursed",
    },
    {
      state_key: "expired",
      label: "Expired",
      source_table: "return_items (scanner) / amazon_fba_inventory inv_age buckets",
      source_file_api: "Scanner conditions + Inventory Health age columns",
      quantity_field: "scanned_quantity / inv_age_366_plus_days (proxy only)",
      event_date_field: "created_at / snapshot_date",
      reference_id_type: "return_item_id / fnsku snapshot",
      confidence_default: "low_for_fba_proxy",
      freshness_class: "mixed",
      source_availability: "partial",
      safe_for_display: "scanner_yes_fba_proxy_badge_only",
      safe_for_claim_candidate: "scanner_only",
      human_review: "FBA age bucket is not expiry date",
      aggregation: "scanner expired tag qty separate from age bucket",
    },
    {
      state_key: "stranded",
      label: "Stranded",
      source_table: "amazon_fba_inventory (alert/recommended_action) / stranded report raw",
      source_file_api: "Stranded Inventory report (not normalized)",
      quantity_field: "estimated_excess_quantity / report-dependent stranded_units in raw_data",
      event_date_field: "snapshot_date",
      reference_id_type: "fnsku",
      confidence_default: "low",
      freshness_class: "snapshot",
      source_availability: "empty_or_stale",
      safe_for_display: "no_primary",
      safe_for_claim_candidate: "no",
      human_review: "always until dedicated import",
      aggregation: "none until stranded report normalized",
    },
    {
      state_key: "reimbursed",
      label: "Reimbursed (observed)",
      source_table: "amazon_reimbursements",
      source_file_api: "REIMBURSEMENTS report",
      quantity_field: "quantity_reimbursed_total",
      event_date_field: "approval_date",
      reference_id_type: "reimbursement_id",
      confidence_default: "high",
      freshness_class: "event_ledger",
      source_availability: "current",
      safe_for_display: "yes_observed_not_expected",
      safe_for_claim_candidate: "no_positive_reimbursement",
      human_review: "clawback/reversal rows only for new claims",
      aggregation: "sum observed reimbursed qty; NEVER treat as expected recovery",
    },
    {
      state_key: "unreimbursed_gap",
      label: "Unreimbursed gap",
      source_table: "amazon_inventory_ledger + amazon_safet_claims",
      source_file_api: "INVENTORY_LEDGER unreconciled + SAFE-T claims",
      quantity_field: "unreconciled_quantity minus reimbursed overlap",
      event_date_field: "event_date / claim_date",
      reference_id_type: "reference_id / safet_claim_id",
      confidence_default: "medium",
      freshness_class: "computed",
      source_availability: "partial_safet_empty",
      safe_for_display: "yes_with_cogs_unknown",
      safe_for_claim_candidate: "yes_not_from_single_source",
      human_review: "always when COGS missing; SAFE-T empty = source unavailable not zero",
      aggregation: "computed gap = loss/disposal/damage events - reimbursed qty for same reference; multi-source required",
    },
    {
      state_key: "fee_or_dimension_issue",
      label: "Fee / dimension issue (possible claim qty)",
      source_table: "amazon_fee_preview / amazon_monthly_storage_fees / product_packaging_dimensions_current",
      source_file_api: "Fee Preview / Monthly Storage / PC04 dimensions",
      quantity_field: "null (amount-based) or 1 unit per fee dispute row",
      event_date_field: "posted_at / month_of_charge / observed_at",
      reference_id_type: "order_id / product_id",
      confidence_default: "low",
      freshness_class: "snapshot_or_computed",
      source_availability: "empty_on_staging",
      safe_for_display: "badge_only",
      safe_for_claim_candidate: "no_until_policy",
      human_review: "always; PC04 exists but fee tables empty",
      aggregation: "deferred — policy + generator not live",
    },
  ];
}

function sourceToStateMapping(): Row[] {
  return [
    { source: "amazon_inventory_ledger", states: ["disposed", "damaged", "lost", "unreimbursed_gap"], join_keys: ["fnsku", "sku", "asin", "reference_id"], product_resolution: "product_identifier_map + resolved_product_id sparse" },
    { source: "amazon_fba_inventory", states: ["available_fba", "reserved_fba", "sent_to_amazon adjunct", "stranded proxy", "expired proxy"], join_keys: ["fnsku", "asin", "sku"], product_resolution: "product_identifier_map" },
    { source: "amazon_manage_fba_inventory", states: ["available_fba", "reserved_fba"], join_keys: ["fnsku", "asin", "sku"], product_resolution: "resolved_product_id column when populated" },
    { source: "amazon_returns", states: ["customer_returned", "damaged"], join_keys: ["fnsku", "asin", "sku", "order_id"], product_resolution: "product_identifier_map" },
    { source: "amazon_removals", states: ["removed_created", "disposed"], join_keys: ["fnsku", "order_id"], product_resolution: "product_identifier_map" },
    { source: "amazon_removal_shipments", states: ["removed_shipped"], join_keys: ["fnsku", "tracking_number", "order_id"], product_resolution: "product_identifier_map" },
    { source: "amazon_reimbursements", states: ["reimbursed"], join_keys: ["fnsku", "order_id", "reimbursement_id"], product_resolution: "product_identifier_map + FRR" },
    { source: "amazon_settlements", states: ["sold", "refunded_or_canceled"], join_keys: ["sku", "asin", "order_id"], product_resolution: "product_identifier_map" },
    { source: "amazon_transactions", states: ["sold", "refunded_or_canceled"], join_keys: ["sku", "order_id"], product_resolution: "product_identifier_map" },
    { source: "amazon_inbound_performance", states: ["sent_to_amazon", "received_by_amazon"], join_keys: ["fnsku", "asin", "sku", "fba_shipment_id"], product_resolution: "product_identifier_map" },
    { source: "amazon_safet_claims", states: ["unreimbursed_gap"], join_keys: ["safet_claim_id", "fnsku"], product_resolution: "FRR + reference_id" },
    { source: "expected_packages", states: ["removed_shipped forecast"], join_keys: ["fnsku", "tracking_number"], product_resolution: "shipment_scope; exclude disputed" },
    { source: "return_items", states: ["warehouse_internal", "damaged", "expired"], join_keys: ["fnsku", "product_id"], product_resolution: "direct product_id when linked" },
    { source: "financial_reference_resolver", states: ["money context for all financial states"], join_keys: ["trid_key", "source_table", "source_row_id"], product_resolution: "selected_financial_trid_key" },
    { source: "claim_reference_edges", states: ["claim anchor corroboration"], join_keys: ["draft_id", "edge_type", "target_trid_key"], product_resolution: "via candidate resolved_product_id" },
    { source: "product_identifier_map", states: ["all — spine join"], join_keys: ["fnsku", "asin", "seller_sku", "msku"], product_resolution: "canonical product_id per org/store" },
  ];
}

function stateConfidenceRules(): Row {
  return {
    tiers: {
      high: "Single authoritative source row with resolved product_id + event_date + quantity; no conflicting sibling source within tolerance",
      medium: "Source imported but sparse linkage, snapshot stale 15–45d, or requires reason_code/event_type filter",
      low: "Proxy field, empty SAFE-T, stranded not normalized, fee tables empty, or multi-source conflict unresolved",
      disputed: "shipment_overflow_conflict, identifier conflict groups, quarantined claim rows — exclude from primary totals",
    },
    badges: {
      observed: "Amazon/file/API row — quantity as reported",
      computed: "Derived from multiple sources (unreimbursed_gap)",
      snapshot: "Point-in-time — show as_of date",
      scanner: "Physical scan — not Amazon inventory",
      unavailable: "SAFE-T empty or table row_count=0 — show 'Source unavailable' not zero",
      cost_unknown: "COGS missing — show Cost unknown not $0 recovery",
    },
    primary_total_rules: [
      "Never infer claimable qty from one source when another conflicts",
      "Exclude disputed EP rows from removed_shipped primary total",
      "Exclude quarantined claim_candidates from possible_claim_quantity",
      "Do not sum snapshot states across dates",
      "reimbursed is observed — subtract from gap only in computed unreimbursed_gap lane",
    ],
  };
}

function disputedSourceHandling(): Row {
  return {
    patterns: [
      {
        id: "shipment_overflow_conflict",
        example: "tracking 387003587 / FNSKU X004LKS4VD — EP qty-1 overflow vs shipment sum 52",
        tables: ["expected_packages"],
        column: "build_status = 'shipment_overflow_conflict'",
        read_model_rule: "Primary removed_shipped = sum non-disputed EP + removal_shipments; disputed rows in secondary 'Needs reconciliation' bucket",
        claim_candidate_rule: "Generators must filter is_claim_ready / exclude shipment_overflow_conflict per phase-expected-packages-conflict-status-gating-v1",
        ui: "Show grouped shipment card with Expected clean + Needs reconciliation subcounts",
      },
      {
        id: "identifier_conflict",
        example: "product_identifier_map multiple product_ids for same fnsku",
        read_model_rule: "Lifecycle qty requires resolved product_id; ambiguous map → human_review_required on all states",
        claim_candidate_rule: "Block auto candidate until linkage resolved",
      },
      {
        id: "ledger_without_product_link",
        example: "amazon_inventory_ledger.resolved_product_id null",
        read_model_rule: "Show event lines under fnsku-scoped drill-down; product rollup qty flagged medium confidence",
        claim_candidate_rule: "inventory_ledger generator may emit but enrichment blocked without product link",
      },
      {
        id: "multi_source_qty_mismatch",
        example: "removal shipped_quantity vs sum removal_shipments",
        read_model_rule: "Show both sources with badges; primary = higher confidence source per state_confidence_rules",
        claim_candidate_rule: "Never auto-sum; operator picks or generator uses higher-trust table",
      },
    ],
    suspicious_row_exclusion: [
      "quarantined_at IS NOT NULL on claim_candidates",
      "legacy_seed source_kind without corroboration",
      "EP rows with build_status = shipment_overflow_conflict",
      "rows failing identifier_resolution_status != resolved",
    ],
  };
}

function claimCandidateEligibilityRules(): Row {
  return {
    possible_claim_quantity_definition:
      "NOT a single counter — per-family eligible units from generators after policy filters; max(display) = min(observed loss qty, unreimbursed gap) when multi-source agrees",
    rules: [
      { state: "warehouse_internal", eligible: "yes when scanner_physical_review family + product linked", qty_field: "scanned_quantity" },
      { state: "removed_shipped", eligible: "yes when shipment_discrepancy / lost in transit — exclude disputed EP", qty_field: "variance qty" },
      { state: "lost", eligible: "yes via inventory_ledger generator", qty_field: "unreconciled_quantity" },
      { state: "unreimbursed_gap", eligible: "yes only when ledger + reimbursement corroboration", qty_field: "computed gap" },
      { state: "reimbursed", eligible: "no for positive reimbursement; reversal/clawback only", qty_field: "quantity_reimbursed_total" },
      { state: "customer_returned", eligible: "no until FBA returns generator built", qty_field: "quantity" },
      { state: "available_fba", eligible: "no — informational only", qty_field: null },
      { state: "sold", eligible: "no alone — adjacent settlement anomalies only", qty_field: null },
      { state: "fee_or_dimension_issue", eligible: "deferred", qty_field: null },
    ],
    never: [
      "Do not set possible_claim_quantity = available_fba",
      "Do not treat reimbursed amount as expected recovery",
      "Do not emit candidate from title-only match",
      "Do not use disputed EP rows",
    ],
  };
}

function uiPayloadContract(): Row {
  return {
    endpoint_shape: "nested under product detail / Claim Center product drill-down",
    top_level: {
      product_id: "uuid",
      organization_id: "uuid",
      store_id: "uuid",
      as_of: "ISO timestamp of read-model build",
      linkage_status: "resolved | ambiguous | unresolved",
      primary_product_label: "from products.title — not used for matching",
    },
    lifecycle_summary: {
      description: "Array of state chips — only states with display-safe qty or explicit unavailable badge",
      item: {
        state_key: "string",
        label: "string",
        quantity: "number | null",
        quantity_display: "string — e.g. '12', 'Source unavailable', 'Cost unknown'",
        as_of: "ISO | null",
        confidence: "high | medium | low | disputed",
        source_badge: "observed | computed | snapshot | scanner | unavailable",
        safe_for_display: "boolean",
        human_review_required: "boolean",
        drill_down_href: "/api/products/{id}/lifecycle-quantities/{state_key}/lines",
      },
    },
    disputed_bucket: {
      label: "Needs reconciliation",
      quantity: "number",
      rows: "line references excluded from primary",
    },
    money_lanes: {
      sale_context: "product_prices — never COGS",
      actual_cost: "Cost unknown when cogs missing",
      observed_reimbursement: "sum amazon_reimbursements.amount_total — not expected recovery",
    },
    claim_opportunity_hint: {
      possible_claim_quantity: "number | null",
      note: "Only when generator-eligible states agree; otherwise null + explanation",
    },
  };
}

function apiRouteRecommendation(): Row {
  return {
    primary_route: "GET /api/products/[productId]/lifecycle-quantities",
    query_params: {
      storeId: "required uuid",
      asOf: "optional ISO — default latest snapshot per state",
      includeDisputed: "boolean default false",
      includeLines: "boolean default false",
    },
    secondary_routes: [
      "GET /api/products/[productId]/lifecycle-quantities/[stateKey]/lines — paginated source rows",
      "GET /api/claims/center/products/[productId]/lifecycle-summary — Claim Center thin wrapper",
    ],
    implementation_notes: [
      "Read-only SELECT aggregations in lib/product-lifecycle-quantity-readmodel.ts (new)",
      "Reuse product_identifier_map resolution from lib/product-identifier-match",
      "Reuse connector freshness from lib/claims/connectors/source-connector-readmodel.ts",
      "No new tables — materialized view optional later with Maysam approval",
      "RBAC: same as Product Hub read — no change to platform access",
    ],
    response_contract_file: "lib/product-lifecycle-quantity-contract.ts",
  };
}

function filesToDownloadFromAmazon(): string[] {
  return [
    "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA (FBA Customer Returns) — customer_returned",
    "GET_FBA_INVENTORY_AGED_DATA / Inventory Health — available_fba, reserved_fba, age proxies",
    "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA — manage FBA inventory snapshot",
    "GET_LEDGER_DETAIL_VIEW_DATA / Inventory Ledger — lost, disposed, unreimbursed_gap",
    "GET_FBA_REIMBURSEMENTS_DATA — reimbursed observed",
    "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA — removed_created, disposed",
    "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA — removed_shipped",
    "GET_FBA_INBOUND_DEFECT_DATA / Inbound Performance — sent_to_amazon, received_by_amazon",
    "GET_STRANDED_INVENTORY_UI_DATA — stranded (not normalized today)",
    "GET_FBA_STORAGE_FEE_CHARGES_DATA — fee_or_dimension_issue adjunct",
    "GET_V2_SETTLEMENT_REPORT_DATA — sold, refunded_or_canceled",
  ];
}

function apiSourcesToEnable(): Row[] {
  return [
    { api: "SP-API Reports — scheduled FBA inventory + ledger + reimbursements", priority: "P0", unlocks: ["available_fba", "lost", "reimbursed", "unreimbursed_gap"] },
    { api: "SP-API Reports — removal order + shipment detail", priority: "P0", unlocks: ["removed_created", "removed_shipped"] },
    { api: "SP-API Reports — inbound performance", priority: "P1", unlocks: ["sent_to_amazon", "received_by_amazon"] },
    { api: "SP-API Reports — FBA customer returns", priority: "P1", unlocks: ["customer_returned"] },
    { api: "SP-API Finances API (events) — optional adjunct", priority: "P2", unlocks: ["sold", "refunded_or_canceled", "fee_or_dimension_issue"] },
    { api: "Product Catalog Items API — already used for product sync", priority: "P2", unlocks: ["product spine linkage only"] },
    { api: "Amazon product sync scheduler — currently disabled", priority: "P1", unlocks: ["fresh snapshots for display as_of"] },
  ];
}

async function traceX004(c: pg.Client): Promise<Row> {
  const fnsku = SAMPLES.removal_fnsku;
  const tracking = SAMPLES.tracking;
  const trace: Row = { fnsku, tracking, product_id: null, states: {} as Row };

  const pim = await c.query(
    `SELECT product_id::text, asin, seller_sku, match_source, confidence_score
     FROM product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND upper(btrim(fnsku)) = upper(btrim($3)) LIMIT 5`,
    [ORG, STORE, fnsku],
  );
  trace.product_identifier_map = pim.rows;
  trace.product_id = (pim.rows[0] as Row)?.product_id ?? null;

  const tables: Array<{ key: string; sql: string; params: unknown[] }> = [
    {
      key: "amazon_removal_shipments",
      sql: `SELECT id::text, order_id, tracking_number, shipped_quantity, shipment_date::text, carrier
            FROM amazon_removal_shipments
            WHERE organization_id = $1::uuid AND store_id = $2::uuid
              AND (upper(btrim(fnsku)) = upper(btrim($3)) OR tracking_number = $4)
            ORDER BY shipment_date DESC NULLS LAST LIMIT 10`,
      params: [ORG, STORE, fnsku, tracking],
    },
    {
      key: "amazon_removals",
      sql: `SELECT id::text, order_id, order_date::text, requested_quantity, shipped_quantity, disposed_quantity, removal_fee
            FROM amazon_removals
            WHERE organization_id = $1::uuid AND store_id = $2::uuid AND upper(btrim(fnsku)) = upper(btrim($3))
            ORDER BY order_date DESC NULLS LAST LIMIT 10`,
      params: [ORG, STORE, fnsku],
    },
    {
      key: "expected_packages",
      sql: `SELECT id::text, tracking_number, fnsku, expected_scan_quantity, removal_fee, build_status
            FROM expected_packages
            WHERE organization_id = $1::uuid AND store_id = $2::uuid
              AND (tracking_number = $4 OR upper(btrim(fnsku)) = upper(btrim($3)))
            ORDER BY created_at DESC LIMIT 20`,
      params: [ORG, STORE, fnsku, tracking],
    },
    {
      key: "amazon_inventory_ledger",
      sql: `SELECT id::text, event_type, event_date::text, quantity, unreconciled_quantity, reference_id, reason_code, disposition
            FROM amazon_inventory_ledger
            WHERE organization_id = $1::uuid AND upper(btrim(fnsku)) = upper(btrim($2))
            ORDER BY event_date DESC NULLS LAST LIMIT 10`,
      params: [ORG, fnsku],
    },
    {
      key: "amazon_reimbursements",
      sql: `SELECT id::text, reimbursement_id, quantity_reimbursed_total, amount_total, approval_date::text, reason
            FROM amazon_reimbursements
            WHERE organization_id = $1::uuid AND store_id = $2::uuid AND upper(btrim(fnsku)) = upper(btrim($3))
            ORDER BY approval_date DESC NULLS LAST LIMIT 5`,
      params: [ORG, STORE, fnsku],
    },
    {
      key: "amazon_fba_inventory",
      sql: `SELECT id::text, snapshot_date::text, available, total_reserved_quantity, inbound_shipped, unfulfillable_quantity
            FROM amazon_fba_inventory
            WHERE organization_id = $1::uuid AND store_id = $2::uuid AND upper(btrim(fnsku)) = upper(btrim($3))
            ORDER BY snapshot_date DESC NULLS LAST LIMIT 3`,
      params: [ORG, STORE, fnsku],
    },
  ];

  for (const t of tables) {
    if (!(await tableExists(c, t.key))) {
      trace[t.key] = { error: "missing_table" };
      continue;
    }
    try {
      const r = await c.query(t.sql, t.params);
      trace[t.key] = { count: r.rows.length, rows: r.rows };
    } catch (e) {
      trace[t.key] = { error: String(e) };
    }
  }

  const epRows = Array.isArray((trace.expected_packages as Row)?.rows)
    ? ((trace.expected_packages as Row).rows as Row[])
    : [];
  const disputed = epRows.filter((r) => r.build_status === "shipment_overflow_conflict");
  const primaryEp = epRows.filter((r) => r.build_status !== "shipment_overflow_conflict");
  const shipRows = Array.isArray((trace.amazon_removal_shipments as Row)?.rows)
    ? ((trace.amazon_removal_shipments as Row).rows as Row[])
    : [];

  trace.lifecycle_quantity_preview = {
    removed_shipped_primary_qty:
      shipRows.reduce((s, r) => s + Number(r.shipped_quantity ?? 0), 0) ||
      primaryEp.reduce((s, r) => s + Number(r.expected_scan_quantity ?? 0), 0),
    removed_shipped_disputed_qty: disputed.reduce((s, r) => s + Number(r.expected_scan_quantity ?? 0), 0),
    removed_created_qty: Array.isArray((trace.amazon_removals as Row)?.rows)
      ? ((trace.amazon_removals as Row).rows as Row[]).reduce(
          (s, r) => s + Number(r.requested_quantity ?? r.shipped_quantity ?? 0),
          0,
        )
      : 0,
    available_fba_latest: ((trace.amazon_fba_inventory as Row)?.rows as Row[] | undefined)?.[0]?.available ?? null,
    reimbursed_qty: Array.isArray((trace.amazon_reimbursements as Row)?.rows)
      ? ((trace.amazon_reimbursements as Row).rows as Row[]).reduce(
          (s, r) => s + Number(r.quantity_reimbursed_total ?? 0),
          0,
        )
      : 0,
    note: "Preview only — contract run; not wired to API",
  };

  return trace;
}

async function pickSample(c: pg.Client, table: string, minRows = 2): Promise<Row | null> {
  if (!(await tableExists(c, table))) return null;
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  const colSet = new Set(cols.rows.map((x: { column_name: string }) => x.column_name));
  const idCol = colSet.has("fnsku") ? "fnsku" : colSet.has("asin") ? "asin" : colSet.has("sku") ? "sku" : null;
  if (!idCol) return null;
  const qtyExpr = colSet.has("quantity_reimbursed_total")
    ? "sum(quantity_reimbursed_total)"
    : colSet.has("shipped_quantity")
      ? "sum(shipped_quantity)"
      : colSet.has("requested_quantity")
        ? "sum(requested_quantity)"
        : colSet.has("quantity")
          ? "sum(quantity)"
          : "count(*)";
  const r = await c.query(
    `SELECT ${idCol} AS id_val, count(*)::int AS n, ${qtyExpr}::int AS qty_sum
     FROM public.${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND btrim(coalesce(${idCol},'')) <> ''
     GROUP BY ${idCol}
     HAVING count(*) >= $3
     ORDER BY count(*) DESC
     LIMIT 1`,
    [ORG, STORE, minRows],
  ).catch(() => ({ rows: [] }));
  return (r.rows[0] as Row) ?? null;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  if (getStagingProjectRef() !== STAGING_REF) throw new Error(`BLOCKED: staging ref ${STAGING_REF}`);

  const run = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run);
  fs.mkdirSync(outDir, { recursive: true });

  const c = await connectPg();

  const sourceTables = [
    "amazon_inventory_ledger",
    "amazon_fba_inventory",
    "amazon_manage_fba_inventory",
    "amazon_returns",
    "amazon_removals",
    "amazon_removal_shipments",
    "amazon_reimbursements",
    "amazon_settlements",
    "amazon_transactions",
    "amazon_inbound_performance",
    "amazon_safet_claims",
    "financial_reference_resolver",
    "expected_packages",
    "return_items",
    "product_identifier_map",
    "claim_reference_edges",
    "amazon_fee_preview",
    "amazon_monthly_storage_fees",
  ];

  const source_census: Row[] = [];
  for (const t of sourceTables) {
    const count = await tableCount(c, t);
    source_census.push({
      table: t,
      row_count_org: count,
      last_import_at: await lastImportAt(c, t),
      exists: count !== null,
    });
  }

  const X004LKS4VD_trace = await traceX004(c);

  const spineTrace = await c.query(
    `SELECT count(*)::int AS map_hits FROM product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND upper(btrim(fnsku)) = upper(btrim($3))`,
    [ORG, STORE, SAMPLES.spine_fnsku],
  );

  const reimbSample = await pickSample(c, "amazon_reimbursements");
  const returnSample = await pickSample(c, "amazon_returns");
  const removalSample = await pickSample(c, "amazon_removals");

  const sample_products = {
    removal_shipment: { fnsku: SAMPLES.removal_fnsku, tracking: SAMPLES.tracking, trace: X004LKS4VD_trace },
    spine: {
      fnsku: SAMPLES.spine_fnsku,
      product_id: SAMPLES.spine_product_id,
      map_hits: spineTrace.rows[0],
    },
    reimbursement_pick: reimbSample,
    customer_return_pick: returnSample,
    removal_order_pick: removalSample,
  };

  await c.end();

  const missing_sources = source_census
    .filter((s) => s.row_count_org === 0 || s.row_count_org === null)
    .map((s) => ({
      table: s.table,
      status: s.row_count_org === null ? "table_missing" : "empty",
      impact: sourceToStateMapping()
        .filter((m) => String(m.source).includes(String(s.table)))
        .flatMap((m) => m.states as string[]),
    }));

  const lifecycle_quantity_contract = lifecycleQuantityContract();
  const source_to_state_mapping = sourceToStateMapping();
  const state_confidence_rules = stateConfidenceRules();
  const disputed_source_handling = disputedSourceHandling();
  const claim_candidate_eligibility_rules = claimCandidateEligibilityRules();
  const UI_payload_contract = uiPayloadContract();
  const API_route_recommendation = apiRouteRecommendation();
  const files_to_download_from_amazon = filesToDownloadFromAmazon();
  const api_sources_to_enable = apiSourcesToEnable();

  const emptyCritical = ["amazon_safet_claims", "amazon_fee_preview", "amazon_monthly_storage_fees"].every(
    (t) => source_census.find((s) => s.table === t)?.row_count_org === 0,
  );

  const SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL = "yes";
  const NEXT_EXACT_PROMPT = `PHASE-PRODUCT-AMAZON-LIFECYCLE-QUANTITY-READMODEL-IMPLEMENT-V1
Mode: staging read-model implement (SELECT only).
Build lib/product-lifecycle-quantity-readmodel.ts + GET /api/products/[productId]/lifecycle-quantities.
Use lifecycle_quantity_contract from phase-product-amazon-lifecycle-quantity-readmodel-contract-v1/${run}/.
No new tables; no claim_candidates writes; exclude disputed EP from primary totals.
Wire Claim Center product drill-down chips; defer fee/stranded until imports populated.`;

  const outputs = {
    lifecycle_quantity_contract,
    source_to_state_mapping,
    state_confidence_rules,
    X004LKS4VD_trace: X004LKS4VD_trace,
    sample_products,
    source_census,
    disputed_source_handling,
    claim_candidate_eligibility_rules,
    UI_payload_contract,
    API_route_recommendation,
    missing_sources,
    files_to_download_from_amazon,
    api_sources_to_enable,
    SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL,
    SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL_note:
      "Read-only aggregated counters from existing tables is safe; possible_claim_quantity remains generator-governed not a single sum",
    NEXT_EXACT_PROMPT,
  };

  for (const [key, val] of Object.entries(outputs)) {
    if (key === "NEXT_EXACT_PROMPT") {
      fs.writeFileSync(path.join(outDir, `${key}.txt`), String(val));
    } else {
      fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(val, null, 2));
    }
  }

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-PRODUCT-AMAZON-LIFECYCLE-QUANTITY-READMODEL-CONTRACT-V1",
        run_id: run,
        mode: "read_only",
        staging_ref: STAGING_REF,
        organization_id: ORG,
        store_id: STORE,
        lifecycle_states: lifecycle_quantity_contract.length,
        empty_critical_fee_safet: emptyCritical,
        SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "contract-summary.md"),
    [
      "# Product Amazon lifecycle quantity read-model contract V1",
      "",
      `**Run:** \`${run}\` · **Staging:** \`${STAGING_REF}\``,
      "",
      "## Result",
      "",
      `- Lifecycle states defined: **${lifecycle_quantity_contract.length}**`,
      `- X004LKS4VD / 387003587 trace: **${X004LKS4VD_trace.lifecycle_quantity_preview ? "populated" : "partial"}**`,
      `- SAFE-T / fee tables empty: **${emptyCritical ? "yes" : "partial"}**`,
      `- **SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL:** **${SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL}**`,
      "",
      "## Next",
      "",
      "```text",
      NEXT_EXACT_PROMPT,
      "```",
    ].join("\n"),
  );

  console.log(
    JSON.stringify(
      { ok: true, outDir, states: lifecycle_quantity_contract.length, SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
