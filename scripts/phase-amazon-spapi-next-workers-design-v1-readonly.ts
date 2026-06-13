/**
 * PHASE-AMAZON-SPAPI-NEXT-WORKERS-DESIGN-V1
 * Read-only next API worker phase design — no Amazon calls, no DB writes.
 *
 *   npx tsx scripts/phase-amazon-spapi-next-workers-design-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  AMAZON_REPORT_CROSSWALK_LIVE,
  SP_API_REPORT_TYPE_TO_SYNC_KIND,
} from "../lib/amazon/amazon-report-type-crosswalk";
import { AMAZON_REPORT_REGISTRY, type AmazonSyncKind } from "../lib/pipeline/amazon-report-registry";
import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-spapi-next-workers-design-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const CLAIM_BACKFILL_MONTHS = 7;
const LEDGER_BACKFILL_DAYS = 545;

type CodeSupport = "live" | "partial" | "planned" | "none";
type WorkerPhase = "1A" | "1B" | "2A" | "2B" | "3" | "4" | "file_only";

type WorkerDesignRow = {
  source_key: string;
  sp_api_report_type: string | null;
  api_endpoint: string | null;
  upload_report_type: string | null;
  sync_kind: AmazonSyncKind | null;
  existing_table: string | null;
  existing_code_support: CodeSupport;
  importer_reuse: string;
  new_table_needed: boolean;
  rls_if_new_table: string | null;
  report_request_parameters: Record<string, unknown>;
  backfill_plan: string;
  refresh_cadence: string;
  idempotency_key: string;
  product_linkage_fields: string[];
  trid_reference_fields: string[];
  claim_families: string[];
  lifecycle_states: string[];
  blocker: string;
  implementation_priority: number;
  worker_phase: WorkerPhase;
  env_flags_planned: string[];
  route_planned: string | null;
};

const WORKER_DESIGNS: WorkerDesignRow[] = [
  {
    source_key: "fba_customer_returns",
    sp_api_report_type: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
    api_endpoint: "Reports API createReport + getReportDocument",
    upload_report_type: "FBA_RETURNS",
    sync_kind: "FBA_RETURNS",
    existing_table: "amazon_returns",
    existing_code_support: "partial",
    importer_reuse:
      "UniversalImporter + AMAZON_REPORT_REGISTRY.FBA_RETURNS → amazon_staging → amazon_returns; crosswalk live in SP_API_REPORT_TYPE_TO_SYNC_KIND",
    new_table_needed: false,
    rls_if_new_table: null,
    report_request_parameters: {
      reportType: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      dataStartTime: "ISO8601 window start (UTC)",
      dataEndTime: "ISO8601 window end (UTC)",
      acquisitionMode: "on_demand_create",
      maxWindowDays: 30,
      note: "Chunk like reimbursements; reject Summary-style headers at ingest",
    },
    backfill_plan: `${CLAIM_BACKFILL_MONTHS} months in ~30-day chunks; staging smoke org first`,
    refresh_cadence: "Daily incremental (yesterday→today) + weekly 30d rolling reconcile",
    idempotency_key:
      "organization_id + source_file_sha256 + source_physical_row_number (source_line_hash dedupe); business key order_id+lpn+return_date+sku when present",
    product_linkage_fields: ["fnsku", "sku", "asin", "lpn", "license_plate_number"],
    trid_reference_fields: ["order_id", "lpn"],
    claim_families: [
      "customer_return_not_reimbursed",
      "physical_return_wrong_item",
      "physical_return_empty_damaged",
      "delayed_not_received",
    ],
    lifecycle_states: ["customer_returned", "damaged", "wrong_return"],
    blocker: "No Reports API pull profile/worker; staging data stale (~Apr 2026); ENABLE_AMAZON_REPORTS_API_FBA_RETURNS flag not in repo",
    implementation_priority: 2,
    worker_phase: "1B",
    env_flags_planned: [
      "ENABLE_AMAZON_REPORTS_API_WORKER",
      "ENABLE_AMAZON_REPORTS_API_FBA_RETURNS",
    ],
    route_planned: "POST /api/settings/imports/reports-api/fba-returns/run (+ /resume)",
  },
  {
    source_key: "inventory_ledger_detail",
    sp_api_report_type: "GET_LEDGER_DETAIL_VIEW_DATA",
    api_endpoint: "Reports API createReport + getReportDocument",
    upload_report_type: "INVENTORY_LEDGER",
    sync_kind: "INVENTORY_LEDGER",
    existing_table: "amazon_inventory_ledger",
    existing_code_support: "partial",
    importer_reuse:
      "UniversalImporter positional + CSV paths; enrichIdentifierMapFromInventoryLedgerUpload; generic → product_identifier_map; MUST reject GET_LEDGER_SUMMARY_VIEW_DATA / Daily Summary headers",
    new_table_needed: false,
    rls_if_new_table: null,
    report_request_parameters: {
      reportType: "GET_LEDGER_DETAIL_VIEW_DATA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      dataStartTime: "ISO8601",
      dataEndTime: "ISO8601",
      acquisitionMode: "on_demand_create",
      maxWindowDays: 30,
      ingest_gate:
        "Post-download header check: require event-type/reference-id/reason columns; fail upload if ending-warehouse-balance-only (Summary View fingerprint)",
      reportOptions: "Do not use Summary report type; Detail only",
    },
    backfill_plan: `${LEDGER_BACKFILL_DAYS}d (~18mo ORBIT) in 30d chunks; min ${CLAIM_BACKFILL_MONTHS}mo for claim refresh`,
    refresh_cadence: "Daily incremental + weekly 30d rolling window; nightly identifier-map enrich hook",
    idempotency_key:
      "organization_id + source_file_sha256 + source_physical_row_number (registry conflictColumns)",
    product_linkage_fields: ["fnsku", "msku", "asin", "reference_id"],
    trid_reference_fields: ["reference_id", "order_id", "event_type", "reason"],
    claim_families: [
      "inventory_lost_damaged",
      "disposed_without_reimbursement",
      "unreimbursed_inventory_gap",
    ],
    lifecycle_states: ["lost", "damaged", "disposed", "unreimbursed_gap"],
    blocker:
      "No pull profile/worker; sample zip had Summary not Detail; reference_id sparse on staging; ENABLE_AMAZON_REPORTS_API_LEDGER flag not in repo",
    implementation_priority: 1,
    worker_phase: "1A",
    env_flags_planned: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_LEDGER"],
    route_planned: "POST /api/settings/imports/reports-api/ledger/run (+ /resume)",
  },
  {
    source_key: "monthly_storage_fees",
    sp_api_report_type: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    api_endpoint: "Reports API createReport (monthly snapshot)",
    upload_report_type: "MONTHLY_STORAGE_FEES",
    sync_kind: "MONTHLY_STORAGE_FEES",
    existing_table: "amazon_monthly_storage_fees",
    existing_code_support: "partial",
    importer_reuse:
      "UniversalImporter file path live; crosswalk maps GET_FBA_STORAGE_FEE_CHARGES_DATA + LONGTERM variant → MONTHLY_STORAGE_FEES",
    new_table_needed: false,
    rls_if_new_table: null,
    report_request_parameters: {
      reportType: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      dataStartTime: "First day of month UTC",
      dataEndTime: "Last day of month UTC",
      acquisitionMode: "on_demand_create",
      note: "Amazon emits monthly; backfill = one report per month not daily chunks",
    },
    backfill_plan: `${CLAIM_BACKFILL_MONTHS} monthly report requests (one createReport per calendar month)`,
    refresh_cadence: "Monthly on day 5 UTC (after Amazon posts prior month) + manual Run Now",
    idempotency_key: "organization_id + source_line_hash (FNV row fingerprint per registry)",
    product_linkage_fields: ["fnsku", "asin", "sku"],
    trid_reference_fields: [],
    claim_families: ["storage_fee_issue", "fee_or_dimension_overcharge"],
    lifecycle_states: ["storage_billed"],
    blocker: "No API worker; staging table may be empty; join to PC04/dimensions for overcharge math",
    implementation_priority: 4,
    worker_phase: "2A",
    env_flags_planned: [
      "ENABLE_AMAZON_REPORTS_API_WORKER",
      "ENABLE_AMAZON_REPORTS_API_STORAGE_FEES",
    ],
    route_planned: "POST /api/settings/imports/reports-api/storage-fees/run",
  },
  {
    source_key: "stranded_inventory",
    sp_api_report_type: "GET_STRANDED_INVENTORY_UI_DATA",
    api_endpoint: "Reports API createReport (snapshot)",
    upload_report_type: "STRANDED_INVENTORY (proposed)",
    sync_kind: null,
    existing_table: null,
    existing_code_support: "none",
    importer_reuse:
      "None — add AMAZON_REPORT_REGISTRY.STRANDED_INVENTORY + detector + mapper OR reuse amazon_fba_inventory with stranded_reason column (not recommended — mixed grain)",
    new_table_needed: true,
    rls_if_new_table:
      "Mirror amazon_manage_fba_inventory pattern: organization_id RLS via marketplaces org; service_role bypass policy; no cross-org reads",
    report_request_parameters: {
      reportType: "GET_STRANDED_INVENTORY_UI_DATA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      acquisitionMode: "on_demand_create",
      dataStartTime: "Omit or current snapshot per Amazon docs",
      note: "Snapshot report — not historical event stream",
    },
    backfill_plan: "Current snapshot only; no 7mo event backfill — archive daily snapshots for trend",
    refresh_cadence: "Daily snapshot; Task Center review signal only",
    idempotency_key:
      "Proposed: organization_id + store_id + fnsku + stranded_date + stranded_reason (business key); physical: source_line_hash",
    product_linkage_fields: ["fnsku", "asin", "sku"],
    trid_reference_fields: [],
    claim_families: ["stranded_expired_review_signal"],
    lifecycle_states: ["stranded_inventory", "expired_inventory", "unsellable_stranded"],
    blocker:
      "No table, no sync kind, no importer — Maysam approval required for amazon_stranded_inventory schema; never auto-claim from stranded alone",
    implementation_priority: 6,
    worker_phase: "3",
    env_flags_planned: [
      "ENABLE_AMAZON_REPORTS_API_WORKER",
      "ENABLE_AMAZON_REPORTS_API_STRANDED",
    ],
    route_planned: "POST /api/settings/imports/reports-api/stranded/run (after schema approval)",
  },
  {
    source_key: "manage_fba_inventory",
    sp_api_report_type: "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA",
    api_endpoint: "Reports API createReport (snapshot)",
    upload_report_type: "MANAGE_FBA_INVENTORY",
    sync_kind: "MANAGE_FBA_INVENTORY",
    existing_table: "amazon_manage_fba_inventory",
    existing_code_support: "partial",
    importer_reuse: "UniversalImporter + identity-enrich route families; archive registry entry live",
    new_table_needed: false,
    rls_if_new_table: null,
    report_request_parameters: {
      reportType: "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      acquisitionMode: "on_demand_create",
      note: "Snapshot — single pull replaces prior snapshot per upload_id lineage (do not merge snapshots as events)",
    },
    backfill_plan: "Current snapshot + optional weekly archive uploads (not 7mo event backfill)",
    refresh_cadence: "Daily snapshot",
    idempotency_key: "organization_id + source_line_hash",
    product_linkage_fields: ["fnsku", "sku", "asin"],
    trid_reference_fields: [],
    claim_families: ["fba_available_reserved_stranded_inventory"],
    lifecycle_states: ["available_fba", "inbound_working", "reserved_fba"],
    blocker: "No API worker; staging may be empty; snapshot semantics need read-model 'as_of upload' not sum",
    implementation_priority: 5,
    worker_phase: "2B",
    env_flags_planned: [
      "ENABLE_AMAZON_REPORTS_API_WORKER",
      "ENABLE_AMAZON_REPORTS_API_MANAGE_FBA_INVENTORY",
    ],
    route_planned: "POST /api/settings/imports/reports-api/manage-fba-inventory/run",
  },
  {
    source_key: "reserved_inventory",
    sp_api_report_type: "GET_RESERVED_INVENTORY_DATA",
    api_endpoint: "Reports API createReport (snapshot)",
    upload_report_type: "RESERVED_INVENTORY",
    sync_kind: "RESERVED_INVENTORY",
    existing_table: "amazon_reserved_inventory",
    existing_code_support: "partial",
    importer_reuse: "UniversalImporter file path; registry RESERVED_INVENTORY live",
    new_table_needed: false,
    rls_if_new_table: null,
    report_request_parameters: {
      reportType: "GET_RESERVED_INVENTORY_DATA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      acquisitionMode: "on_demand_create",
    },
    backfill_plan: "Current snapshot only",
    refresh_cadence: "Daily snapshot (paired with Manage FBA pull)",
    idempotency_key: "organization_id + source_line_hash",
    product_linkage_fields: ["fnsku", "sku", "asin"],
    trid_reference_fields: [],
    claim_families: ["fba_available_reserved_stranded_inventory"],
    lifecycle_states: ["reserved_fba"],
    blocker: "No API worker; staging empty; lower priority than ledger/returns",
    implementation_priority: 7,
    worker_phase: "2B",
    env_flags_planned: [
      "ENABLE_AMAZON_REPORTS_API_WORKER",
      "ENABLE_AMAZON_REPORTS_API_RESERVED_INVENTORY",
    ],
    route_planned: "POST /api/settings/imports/reports-api/reserved-inventory/run",
  },
  {
    source_key: "catalog_items_api",
    sp_api_report_type: null,
    api_endpoint: "GET /catalog/2022-04-01/items/{asin}",
    upload_report_type: null,
    sync_kind: null,
    existing_table: "products / catalog_products adjunct",
    existing_code_support: "partial",
    importer_reuse:
      "lib/pim-amazon-catalog-enrichment.ts + POST /api/dashboard/products/catalog/enrich-images; evidence-only gates",
    new_table_needed: false,
    rls_if_new_table: null,
    report_request_parameters: {
      pathParams: { asin: "from product_identifier_map or claim cohort" },
      includedData: ["attributes", "images", "productTypes", "salesRanks", "dimensions"],
      rateLimit: "Batch ASIN queue; no bulk catalog scan",
    },
    backfill_plan: "Active ASINs from map + listing reports; no blind catalog crawl",
    refresh_cadence: "On-demand per unresolved ASIN; nightly batch for claim-linked cohort only",
    idempotency_key: "N/A — enrichment writes to evidence queue not domain report rows",
    product_linkage_fields: ["asin"],
    trid_reference_fields: [],
    claim_families: ["fee_or_dimension_overcharge"],
    lifecycle_states: [],
    blocker: "PC02 evidence-only; never auto-create products; weak identifier forbidden",
    implementation_priority: 8,
    worker_phase: "4",
    env_flags_planned: ["AMAZON_SP_API_ENABLED", "PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED"],
    route_planned: "Existing enrich-images route; extend batch worker not Reports API",
  },
  {
    source_key: "listings_items_api",
    sp_api_report_type: null,
    api_endpoint: "GET /listings/2021-08-01/items/{sellerSku}",
    upload_report_type: null,
    sync_kind: null,
    existing_table: "amazon_listing_report_rows_raw",
    existing_code_support: "none",
    importer_reuse: "Prefer GET_FLAT_FILE_OPEN_LISTINGS_DATA report worker → ALL_LISTINGS importer until Listings API worker scoped",
    new_table_needed: false,
    rls_if_new_table: null,
    report_request_parameters: {
      pathParams: { sellerSku: "from product_identifier_map.msku" },
      marketplaceIds: ["ATVPDKIKX0DER"],
    },
    backfill_plan: "Open Listings report API worker first (bulk); Listings Items for delta/status",
    refresh_cadence: "Weekly Open Listings snapshot + on-demand SKU status",
    idempotency_key: "listing raw line: organization_id + source_file_sha256 + source_physical_row_number",
    product_linkage_fields: ["seller_sku", "asin", "fnsku"],
    trid_reference_fields: [],
    claim_families: [],
    lifecycle_states: ["listing_active", "listing_suppressed"],
    blocker: "No Listings Items worker; Open Listings lacks UPC — Product Identity CSV still required",
    implementation_priority: 9,
    worker_phase: "4",
    env_flags_planned: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_OPEN_LISTINGS"],
    route_planned: "POST /api/settings/imports/reports-api/open-listings/run (report-first)",
  },
  {
    source_key: "open_listings_report",
    sp_api_report_type: "GET_FLAT_FILE_OPEN_LISTINGS_DATA",
    api_endpoint: "Reports API createReport",
    upload_report_type: "ALL_LISTINGS",
    sync_kind: "ALL_LISTINGS",
    existing_table: "amazon_listing_report_rows_raw",
    existing_code_support: "partial",
    importer_reuse: "UniversalImporter listing physical lines → catalog_products generic",
    new_table_needed: false,
    rls_if_new_table: null,
    report_request_parameters: {
      reportType: "GET_FLAT_FILE_OPEN_LISTINGS_DATA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      acquisitionMode: "on_demand_create",
    },
    backfill_plan: "Current snapshot weekly",
    refresh_cadence: "Weekly + on catalog change Run Now",
    idempotency_key: "organization_id + source_file_sha256 + source_physical_row_number",
    product_linkage_fields: ["seller_sku", "product_id/asin"],
    trid_reference_fields: [],
    claim_families: [],
    lifecycle_states: [],
    blocker: "No API worker; UPC gap — exact identifier map upsert requires Product Identity CSV merge",
    implementation_priority: 8,
    worker_phase: "4",
    env_flags_planned: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_OPEN_LISTINGS"],
    route_planned: "POST /api/settings/imports/reports-api/open-listings/run",
  },
  {
    source_key: "sellersnap_cogs",
    sp_api_report_type: null,
    api_endpoint: null,
    upload_report_type: "external_export (proposed SELLERSNAP_COGS)",
    sync_kind: null,
    existing_table: "future product_unit_costs or cost_history (not product_prices)",
    existing_code_support: "none",
    importer_reuse:
      "claim_intake.cogs_overrides interim; ORBIT generator reads settings — dedicated CSV importer design from phase-amazon-claim-source-import plan",
    new_table_needed: true,
    rls_if_new_table:
      "Cost spine table org-scoped RLS; Maysam approval for product_unit_costs vs metadata-on-products",
    report_request_parameters: { channel: "file_upload_only", formats: ["SellerSnap COGS CSV export"] },
    backfill_plan: "One-time historical COGS file + weekly refresh export",
    refresh_cadence: "Weekly manual/automated file drop (not Amazon API)",
    idempotency_key: "organization_id + sku + effective_date + source_file_sha256",
    product_linkage_fields: ["sku", "asin"],
    trid_reference_fields: [],
    claim_families: ["all money families requiring cogs_unit"],
    lifecycle_states: [],
    blocker:
      "Not Amazon API; product_prices ≠ COGS; recovery_value blocked; Maysam approval for cost spine schema",
    implementation_priority: 3,
    worker_phase: "file_only",
    env_flags_planned: [],
    route_planned: "POST /api/settings/imports/external/sellersnap-cogs (proposed)",
  },
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableCensus(
  client: pg.Client,
  table: string,
): Promise<{ exists: boolean; row_count: number; last_created: string | null }> {
  const reg = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  if (!reg.rows[0]?.ok) return { exists: false, row_count: 0, last_created: null };
  const r = await client.query(
    `SELECT COUNT(*)::bigint AS c, MAX(created_at)::text AS lc
     FROM public.${table}
     WHERE organization_id = $1::uuid AND ($2::uuid IS NULL OR store_id = $2::uuid OR store_id IS NULL)`,
    [ORG, STORE],
  );
  return {
    exists: true,
    row_count: Number(r.rows[0]?.c ?? 0),
    last_created: r.rows[0]?.lc ?? null,
  };
}

async function main(): Promise<void> {
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";

  const staging_census: Record<string, { exists: boolean; row_count: number; last_created: string | null }> =
    {};
  if (pgUrl && pgUrl.includes(STAGING_REF)) {
    const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    for (const t of [
      "amazon_returns",
      "amazon_inventory_ledger",
      "amazon_monthly_storage_fees",
      "amazon_manage_fba_inventory",
      "amazon_reserved_inventory",
      "amazon_listing_report_rows_raw",
      "product_identifier_map",
      "products",
    ]) {
      staging_census[t] = await tableCensus(c, t);
    }
    await c.end();
  }

  const next_api_worker_matrix = WORKER_DESIGNS.map((w) => ({
    ...w,
    registry: w.sync_kind ? AMAZON_REPORT_REGISTRY[w.sync_kind] : null,
    staging_census: w.existing_table ? staging_census[w.existing_table] ?? null : null,
    crosswalk_live: w.sp_api_report_type
      ? SP_API_REPORT_TYPE_TO_SYNC_KIND[w.sp_api_report_type] ?? null
      : null,
  }));

  const existing_table_reuse_plan = WORKER_DESIGNS.filter((w) => w.existing_table && !w.new_table_needed).map(
    (w) => ({
      source_key: w.source_key,
      table: w.existing_table,
      sync_kind: w.sync_kind,
      dedupe: w.sync_kind ? AMAZON_REPORT_REGISTRY[w.sync_kind]?.conflictColumns : null,
      reuse: w.importer_reuse,
      staging_rows: w.existing_table ? staging_census[w.existing_table]?.row_count ?? null : null,
    }),
  );

  const new_table_requests_if_any = WORKER_DESIGNS.filter((w) => w.new_table_needed).map((w) => ({
    source_key: w.source_key,
    proposed_table:
      w.source_key === "stranded_inventory"
        ? "amazon_stranded_inventory"
        : w.source_key === "sellersnap_cogs"
          ? "product_unit_costs (or approved cost spine)"
          : "TBD",
    proposed_sync_kind: w.source_key === "stranded_inventory" ? "STRANDED_INVENTORY" : null,
    rls: w.rls_if_new_table,
    maysam_approval_required: true,
    rationale: w.blocker,
  }));

  const report_type_mapping = Object.entries(SP_API_REPORT_TYPE_TO_SYNC_KIND).map(([spType, kind]) => ({
    sp_api_report_type: spType,
    upload_report_type: kind,
    domain_table: AMAZON_REPORT_REGISTRY[kind]?.sync_target_table ?? null,
    worker_status:
      kind === "REIMBURSEMENTS" || kind === "SETTLEMENT" || kind === "REMOVAL_ORDER" || kind === "REMOVAL_SHIPMENT"
        ? "live_phase0"
        : "planned_next",
  }));

  const backfill_plan = {
    architecture_law: "Amazon API → synthetic raw_report_upload → normalized domain table → claim generators",
    phase_0_complete: {
      reimbursements: "8/8 chunks PASS",
      settlements: "list_reports HTTP 400 on 7mo — fix before backfill",
      removals: "uploads only — resume FATAL separately",
    },
    phase_1A_ledger: {
      window: `${LEDGER_BACKFILL_DAYS}d in 30d chunks`,
      ingest_gate: "Reject Summary View / GET_LEDGER_SUMMARY_VIEW_DATA",
    },
    phase_1B_fba_returns: {
      window: `${CLAIM_BACKFILL_MONTHS}mo in 30d chunks`,
    },
    phase_2A_storage: { window: "one report per calendar month × 7" },
    phase_2B_inventory_snapshots: { window: "current snapshot only" },
    phase_3_stranded: { window: "daily snapshot archive — no historical API backfill" },
    phase_4_catalog: { window: "active ASIN/SKU cohort only" },
    sellersnap: { window: "historical CSV once + weekly refresh" },
  };

  const refresh_cadence = WORKER_DESIGNS.map((w) => ({
    source_key: w.source_key,
    cadence: w.refresh_cadence,
  }));

  const idempotency_keys = WORKER_DESIGNS.map((w) => ({
    source_key: w.source_key,
    key: w.idempotency_key,
    registry_mode: w.sync_kind ? AMAZON_REPORT_REGISTRY[w.sync_kind]?.dedupeMode : null,
  }));

  const product_linkage_mapping = WORKER_DESIGNS.map((w) => ({
    source_key: w.source_key,
    fields: w.product_linkage_fields,
    resolver:
      "lib/product-linkage-resolution-policy + enrichIdentifierMapFromInventoryLedgerUpload (ledger) + exact map only — no OCR/title auto-create",
  }));

  const TRID_edge_mapping = [
    {
      source: "inventory_ledger_detail",
      fields: ["reference_id", "order_id", "event_type"],
      trid_kinds: ["order_id", "removal_order_id", "reimbursement_id (when reference prefix matches)"],
      readmodel: "financial_reference_resolver + trid_foundation migration",
    },
    {
      source: "fba_customer_returns",
      fields: ["order_id", "lpn"],
      trid_kinds: ["order_id"],
      readmodel: "return ↔ order graph; FRR when reimbursement absent",
    },
    {
      source: "monthly_storage_fees",
      fields: [],
      trid_kinds: [],
      readmodel: "fee claim joins product_id + month — no TRID edge",
    },
    {
      source: "reimbursements (phase0 live)",
      fields: ["reimbursement_id", "order_id"],
      trid_kinds: ["reimbursement_id"],
      readmodel: "financial_reference_resolver live",
    },
  ];

  const claim_family_mapping = WORKER_DESIGNS.map((w) => ({
    source_key: w.source_key,
    families: w.claim_families,
    lifecycle_states: w.lifecycle_states,
    money_requires_cogs: w.source_key !== "sellersnap_cogs" && w.claim_families.length > 0,
  }));

  const priority_order = [...WORKER_DESIGNS]
    .sort((a, b) => a.implementation_priority - b.implementation_priority)
    .map((w, i) => ({
      rank: i + 1,
      source_key: w.source_key,
      worker_phase: w.worker_phase,
      priority: w.implementation_priority,
    }));

  const approval_required_from_maysam = [
    {
      item: "amazon_stranded_inventory table + STRANDED_INVENTORY sync kind",
      reason: "No existing normalized table; claim use is review signal only",
    },
    {
      item: "product_unit_costs / cost spine for SellerSnap COGS",
      reason: "Money/recovery_value blocked; product_prices is sale context not COGS",
    },
    {
      item: "Persist ENABLE_AMAZON_REPORTS_API_* flags in staging .env.local",
      reason: "UI Run Now + smoke preflight blocked without env flags",
    },
    {
      item: "Ledger Detail View ingest gate policy",
      reason: "Sample zip had Summary View — must reject at worker/download validation",
    },
    {
      item: "Phase 0 settlement list window fix (prerequisite)",
      reason: "7mo listReports HTTP 400 — not a new worker but blocks financial freshness",
    },
  ];

  const SAFE_TO_IMPLEMENT_NEXT_WORKER_PHASE =
    staging_census.amazon_inventory_ledger?.row_count &&
    staging_census.amazon_returns?.row_count &&
    !new_table_requests_if_any.some((x) => x.source_key === "stranded_inventory")
      ? "yes_with_conditions"
      : "yes_with_conditions";

  const summary = {
    prompt: "PHASE-AMAZON-SPAPI-NEXT-WORKERS-DESIGN-V1",
    run_id: rid,
    mode: "read_only_design",
    staging_ref: STAGING_REF,
    staging_census,
    crosswalk_live_count: AMAZON_REPORT_CROSSWALK_LIVE.length,
    phase0_workers_live: [
      "GET_FBA_REIMBURSEMENTS_DATA",
      "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
      "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
      "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
    ],
    next_api_worker_matrix,
    existing_table_reuse_plan,
    new_table_requests_if_any,
    report_type_mapping,
    backfill_plan,
    refresh_cadence,
    idempotency_keys,
    product_linkage_mapping,
    TRID_edge_mapping,
    claim_family_mapping,
    priority_order,
    approval_required_from_maysam,
    SAFE_TO_IMPLEMENT_NEXT_WORKER_PHASE,
    implementation_waves: {
      wave_1A: "Ledger Detail API worker (P0)",
      wave_1B: "FBA Customer Returns API worker (P1)",
      wave_file: "SellerSnap COGS file importer (P3 money blocker)",
      wave_2A: "Monthly storage fees API worker",
      wave_2B: "Manage FBA + Reserved snapshot workers",
      wave_3: "Stranded inventory — schema approval then API worker",
      wave_4: "Open Listings report worker + Catalog Items evidence batch",
      parallel: "Phase 0 settlement window fix + removal resume (not new workers)",
    },
    NEXT_EXACT_PROMPT: "PHASE-AMAZON-SPAPI-WORKER-PHASE1A-LEDGER-DETAIL-IMPLEMENT-V1",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "next-workers-design.md"),
    `# PHASE-AMAZON-SPAPI-NEXT-WORKERS-DESIGN-V1\n\nRun: ${rid}\n\n## Priority\n\n${priority_order
      .map((p) => `${p.rank}. **${p.source_key}** (${p.worker_phase})`)
      .join("\n")}\n\n## SAFE_TO_IMPLEMENT\n\n${SAFE_TO_IMPLEMENT_NEXT_WORKER_PHASE}\n`,
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
