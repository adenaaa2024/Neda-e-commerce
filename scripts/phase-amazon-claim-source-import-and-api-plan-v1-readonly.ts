/**
 * PHASE-AMAZON-CLAIM-SOURCE-IMPORT-AND-API-PLAN-V1
 * Read-only import/API implementation plan — no DB writes.
 *
 *   npx tsx scripts/phase-amazon-claim-source-import-and-api-plan-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { CLASSIFIED_REPORT_TYPES } from "../lib/csv-import-detected-type";
import { SP_API_REPORT_TYPE_TO_SYNC_KIND } from "../lib/amazon/amazon-report-type-crosswalk";
import { AMAZON_REPORT_REGISTRY } from "../lib/pipeline/amazon-report-registry";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-claim-source-import-and-api-plan-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const STALE_DAYS = 45;
const REQUIRED_MONTHS = 7;

type Priority = "required_now" | "required_next" | "later" | "optional";

type Classification =
  | "already_imported_usable"
  | "imported_stale"
  | "imported_empty"
  | "file_import_supported"
  | "file_import_missing"
  | "api_sync_available"
  | "api_sync_missing"
  | "later_only";

type SourcePlanRow = {
  source_name: string;
  amazon_report_name: string;
  sp_api_report_type: string | null;
  current_table: string | null;
  report_type: string | null;
  importer_supported: "yes" | "no" | "partial";
  api_automation: "yes" | "no" | "partial";
  ui_upload_suitable: "yes" | "no" | "partial";
  required_columns: string[];
  date_range_needed: string;
  lifecycle_states: string[];
  claim_families: string[];
  row_count: number;
  last_import_at: string | null;
  last_row_at: string | null;
  freshness: "fresh" | "stale" | "missing" | "unknown";
  current_blocker: string;
  priority: Priority;
  classification: Classification[];
  implementation_notes: string;
};

const SPECS: Omit<
  SourcePlanRow,
  "row_count" | "last_import_at" | "last_row_at" | "freshness" | "classification"
>[] = [
  {
    source_name: "FBA Customer Returns",
    amazon_report_name: "FBA Customer Returns",
    sp_api_report_type: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
    current_table: "amazon_returns",
    report_type: "FBA_RETURNS",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["return-date", "order-id", "sku", "asin", "fnsku", "reason", "disposition"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["customer_returned", "damaged"],
    claim_families: ["customer_return_not_reimbursed", "delayed_not_received"],
    current_blocker: "Stale Apr 2026; no SP-API worker wired",
    priority: "required_next",
    implementation_notes: "Registry live; crosswalk maps SP-API type but worker not implemented — file upload primary.",
  },
  {
    source_name: "Inventory Ledger",
    amazon_report_name: "Inventory Ledger Detail",
    sp_api_report_type: "GET_LEDGER_DETAIL_VIEW_DATA",
    current_table: "amazon_inventory_ledger",
    report_type: "INVENTORY_LEDGER",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["date", "fnsku", "asin", "msku", "reference-id", "reason", "event-type", "quantity", "unreconciled-quantity"],
    date_range_needed: "18 months (545d ORBIT); min 7 months refresh",
    lifecycle_states: ["lost", "disposed", "damaged", "unreimbursed_gap"],
    claim_families: ["inventory_lost_damaged", "disposed_without_reimbursement"],
    current_blocker: "Data ends ~2026-04-24; reference_id sparse",
    priority: "required_now",
    implementation_notes: "UniversalImporter + positional ledger detection; no SP-API schedule in repo.",
  },
  {
    source_name: "Inventory Adjustments",
    amazon_report_name: "Inventory Adjustments (Ledger subset)",
    sp_api_report_type: "GET_LEDGER_DETAIL_VIEW_DATA (adjustment reason codes)",
    current_table: "amazon_inventory_ledger",
    report_type: "INVENTORY_LEDGER",
    importer_supported: "partial",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["date", "fnsku", "reason", "event-type", "quantity", "reference-id"],
    date_range_needed: "Same as Inventory Ledger",
    lifecycle_states: ["lost", "damaged"],
    claim_families: ["inventory_lost_damaged"],
    current_blocker: "No separate table — filter ledger by adjustment/M* reason codes at read-model",
    priority: "required_now",
    implementation_notes: "Not a distinct importer; same file as Ledger. UI label as adjustment lines optional later.",
  },
  {
    source_name: "Daily Inventory History",
    amazon_report_name: "Amazon Fulfilled Inventory / Daily History",
    sp_api_report_type: "GET_AFN_INVENTORY_DATA (archive; file typical)",
    current_table: "amazon_amazon_fulfilled_inventory",
    report_type: "AMAZON_FULFILLED_INVENTORY",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["snapshot-date", "sku", "fnsku", "asin", "quantity", "warehouse-condition"],
    date_range_needed: "Rolling 90d snapshot history",
    lifecycle_states: ["available_fba (historical adjunct)"],
    claim_families: ["fba_available_reserved_stranded_inventory"],
    current_blocker: "Archive family — not wired to claim generators",
    priority: "later",
    implementation_notes: "Wave4 registry entry; sync route in app/api/settings/imports/sync — file upload only.",
  },
  {
    source_name: "Removal Order Detail",
    amazon_report_name: "Removal Order Detail",
    sp_api_report_type: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
    current_table: "amazon_removals",
    report_type: "REMOVAL_ORDER",
    importer_supported: "yes",
    api_automation: "yes",
    ui_upload_suitable: "yes",
    required_columns: ["order-id", "sku", "fnsku", "requested-quantity", "shipped-quantity", "in-process-quantity", "order-date"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["removed_created", "disposed"],
    claim_families: ["removal_discrepancy", "removal_missing_units"],
    current_blocker: "Supersession read-model excludes stale partial rows",
    priority: "required_next",
    implementation_notes: "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER + removal_api_sync cron live.",
  },
  {
    source_name: "Removal Shipment Detail",
    amazon_report_name: "Removal Shipment Detail",
    sp_api_report_type: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
    current_table: "amazon_removal_shipments",
    report_type: "REMOVAL_SHIPMENT",
    importer_supported: "yes",
    api_automation: "yes",
    ui_upload_suitable: "yes",
    required_columns: ["order-id", "sku", "fnsku", "tracking-number", "shipped-quantity", "shipment-date"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["removed_shipped"],
    claim_families: ["removal_shipped_vs_detail_mismatch", "shipment_discrepancy"],
    current_blocker: "None critical — primary physical evidence",
    priority: "required_next",
    implementation_notes: "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT; rebuild expected_packages after sync.",
  },
  {
    source_name: "Reimbursements",
    amazon_report_name: "FBA Reimbursements",
    sp_api_report_type: "GET_FBA_REIMBURSEMENTS_DATA",
    current_table: "amazon_reimbursements",
    report_type: "REIMBURSEMENTS",
    importer_supported: "yes",
    api_automation: "partial",
    ui_upload_suitable: "yes",
    required_columns: ["reimbursement-id", "order-id", "sku", "fnsku", "quantity-reimbursed-total", "amount-total", "approval-date"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["reimbursed"],
    claim_families: ["reimbursement_verification", "reimbursement_reversal"],
    current_blocker: "Domain rows stale vs upload date — re-sync needed",
    priority: "required_now",
    implementation_notes: "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS + Run Now; file re-upload fallback.",
  },
  {
    source_name: "Transactions / Payments Transaction",
    amazon_report_name: "Transaction View / Simple Transactions Summary",
    sp_api_report_type: null,
    current_table: "amazon_transactions",
    report_type: "TRANSACTIONS",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["date", "transaction-type", "order-id", "sku", "total"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["sold", "refunded_or_canceled"],
    claim_families: ["settlement_refund_anomaly", "transaction_negative_adjustment"],
    current_blocker: "SKU column empty on imported rows — re-export with SKU",
    priority: "required_next",
    implementation_notes: "Finances API adjunct exists but TRANSACTIONS table is file-first.",
  },
  {
    source_name: "Settlements",
    amazon_report_name: "Settlement Flat File V2",
    sp_api_report_type: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
    current_table: "amazon_settlements",
    report_type: "SETTLEMENT",
    importer_supported: "yes",
    api_automation: "partial",
    ui_upload_suitable: "yes",
    required_columns: ["settlement-id", "posted-date", "order-id", "sku", "amount-type", "amount", "transaction-type"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["sold", "refunded_or_canceled"],
    claim_families: ["settlement_refund_anomaly"],
    current_blocker: "Posted data ends ~2026-04-24",
    priority: "required_now",
    implementation_notes: "ENABLE_AMAZON_REPORTS_API_SETTLEMENT + scheduled list profile live.",
  },
  {
    source_name: "FBA Inventory",
    amazon_report_name: "FBA Inventory / Inventory Health",
    sp_api_report_type: "GET_FBA_INVENTORY_AGED_DATA (file typical)",
    current_table: "amazon_fba_inventory",
    report_type: "FBA_INVENTORY",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["sku", "fnsku", "asin", "available", "total-reserved-quantity", "unfulfillable-quantity", "snapshot-date"],
    date_range_needed: "Current snapshot + aged buckets",
    lifecycle_states: ["available_fba", "reserved_fba", "expired", "stranded (proxy via alert)"],
    claim_families: ["fba_available_reserved_stranded_inventory", "expired_inventory"],
    current_blocker: "Stale snapshot; stranded uses alert field only",
    priority: "required_next",
    implementation_notes: "Also MANAGE_FBA_INVENTORY → amazon_manage_fba_inventory as alternate snapshot.",
  },
  {
    source_name: "Reserved Inventory",
    amazon_report_name: "Reserved Inventory",
    sp_api_report_type: null,
    current_table: "amazon_reserved_inventory",
    report_type: "RESERVED_INVENTORY",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["sku", "fnsku", "asin", "reserved-quantity", "reserved-fc-transfer", "reserved-customer-order"],
    date_range_needed: "Current snapshot",
    lifecycle_states: ["reserved_fba"],
    claim_families: ["fba_available_reserved_stranded_inventory"],
    current_blocker: "EMPTY on staging",
    priority: "later",
    implementation_notes: "Registry + header detection live; upload via Settings→Imports.",
  },
  {
    source_name: "Stranded Inventory",
    amazon_report_name: "Stranded Inventory UI / Fix Stranded Inventory",
    sp_api_report_type: "GET_STRANDED_INVENTORY_UI_DATA",
    current_table: null,
    report_type: null,
    importer_supported: "no",
    api_automation: "no",
    ui_upload_suitable: "partial",
    required_columns: ["sku", "asin", "fnsku", "stranded-reason", "stranded-since"],
    date_range_needed: "Current",
    lifecycle_states: ["stranded"],
    claim_families: ["fba_available_reserved_stranded_inventory"],
    current_blocker: "NO sync_target_table in AMAZON_REPORT_REGISTRY; no SP-API worker; lifecycle shows unavailable",
    priority: "later",
    implementation_notes:
      "Codebase path: contract refs GET_STRANDED_INVENTORY_UI_DATA; proxy only via amazon_fba_inventory.alert/recommended_action/estimated_excess_quantity. Need new sync kind STRANDED_INVENTORY + table before claims.",
  },
  {
    source_name: "Inbound Shipment Detail",
    amazon_report_name: "Inbound Shipment / Shipping Queue export",
    sp_api_report_type: "GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA (adjacent)",
    current_table: null,
    report_type: null,
    importer_supported: "no",
    api_automation: "no",
    ui_upload_suitable: "partial",
    required_columns: ["fba-shipment-id", "sku", "fnsku", "quantity-shipped", "quantity-received"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["sent_to_amazon", "received_by_amazon"],
    claim_families: ["inbound_shipment_discrepancy"],
    current_blocker: "No dedicated inbound shipment detail table — use Inbound Performance",
    priority: "later",
    implementation_notes: "Optional future table amazon_inbound_shipments referenced in materialization script only.",
  },
  {
    source_name: "Received Inventory",
    amazon_report_name: "Received quantity (Inbound Performance column)",
    sp_api_report_type: null,
    current_table: "amazon_inbound_performance",
    report_type: "INBOUND_PERFORMANCE",
    importer_supported: "partial",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["fba-shipment-id", "received-quantity", "expected-quantity", "issue-reported-date"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["received_by_amazon"],
    claim_families: ["inbound_shipment_shortage"],
    current_blocker: "Not standalone — received_quantity on inbound_performance rows",
    priority: "required_next",
    implementation_notes: "Same import as Inbound Performance; inbound_shipment generator reads this table.",
  },
  {
    source_name: "Inbound Performance",
    amazon_report_name: "Inbound Performance",
    sp_api_report_type: "GET_FBA_INBOUND_PERFORMANCE_DATA (file typical)",
    current_table: "amazon_inbound_performance",
    report_type: "INBOUND_PERFORMANCE",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["fba-shipment-id", "sku", "fnsku", "problem-type", "problem-quantity", "expected-quantity", "received-quantity"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["sent_to_amazon", "received_by_amazon"],
    claim_families: ["inbound_shipment_shortage", "inbound_shipment_discrepancy"],
    current_blocker: "Stale on staging",
    priority: "required_next",
    implementation_notes: "claim-discovery inbound_shipment source; generator live.",
  },
  {
    source_name: "Shipment Reconciliation",
    amazon_report_name: "FBA Inbound Shipment Reconciliation",
    sp_api_report_type: null,
    current_table: null,
    report_type: null,
    importer_supported: "no",
    api_automation: "no",
    ui_upload_suitable: "partial",
    required_columns: ["shipment-id", "sku", "expected", "received", "discrepancy"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months`,
    lifecycle_states: ["sent_to_amazon", "received_by_amazon"],
    claim_families: ["inbound_shipment_discrepancy"],
    current_blocker: "No table — partial via inbound_performance + expected_packages",
    priority: "later",
    implementation_notes: "Could map to REPORTS_REPOSITORY archive until dedicated importer built.",
  },
  {
    source_name: "FBA Fee Preview",
    amazon_report_name: "Fee Preview",
    sp_api_report_type: "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA (file typical)",
    current_table: "amazon_fee_preview",
    report_type: "FEE_PREVIEW",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["sku", "fnsku", "asin", "estimated-fee-total", "expected-fulfillment-fee-per-unit"],
    date_range_needed: "Current snapshot",
    lifecycle_states: ["fee_or_dimension_issue"],
    claim_families: ["fee_dimension_overcharge"],
    current_blocker: "EMPTY on staging",
    priority: "later",
    implementation_notes: "Registry live; claim generator deferred.",
  },
  {
    source_name: "Monthly Storage Fees",
    amazon_report_name: "Monthly Storage Fees",
    sp_api_report_type: "GET_FBA_STORAGE_FEE_CHARGES_DATA / GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA",
    current_table: "amazon_monthly_storage_fees",
    report_type: "MONTHLY_STORAGE_FEES",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["asin", "fnsku", "month-of-charge", "estimated-monthly-storage-fee"],
    date_range_needed: "Last 12 months",
    lifecycle_states: ["fee_or_dimension_issue"],
    claim_families: ["storage_fee_issue"],
    current_blocker: "EMPTY on staging",
    priority: "later",
    implementation_notes: "Crosswalk maps SP-API storage fee types but no worker scheduled.",
  },
  {
    source_name: "SAFE-T Claims",
    amazon_report_name: "SAFE-T reimbursement",
    sp_api_report_type: null,
    current_table: "amazon_safet_claims",
    report_type: "SAFET_CLAIMS",
    importer_supported: "yes",
    api_automation: "no",
    ui_upload_suitable: "yes",
    required_columns: ["SAFE-T Claim ID", "Order ID", "ASIN", "Claim Reason", "Claim Status", "Reimbursement Amount", "Claim Date"],
    date_range_needed: `Last ${REQUIRED_MONTHS} months — Maysam recent file EMPTY`,
    lifecycle_states: ["unreimbursed_gap"],
    claim_families: ["safet_claims", "safet_followup"],
    current_blocker: "EMPTY — 0 rows; recent Seller Central export empty; source unavailable not zero",
    priority: "required_now",
    implementation_notes: "Importer + dedupe by safet_claim_id live. Maysam must obtain non-empty report or alternate window.",
  },
  {
    source_name: "SellerSnap COGS export",
    amazon_report_name: "SellerSnap unit cost export (external)",
    sp_api_report_type: null,
    current_table: "product_prices",
    report_type: null,
    importer_supported: "no",
    api_automation: "no",
    ui_upload_suitable: "partial",
    required_columns: ["sku", "asin", "unit_cost", "effective_date"],
    date_range_needed: "Current SKU/ASIN costs",
    lifecycle_states: ["all money lanes"],
    claim_families: ["all recovery_value families", "ORBIT/FRA"],
    current_blocker: "product_prices is sale context NOT COGS; dedicated COGS importer not built",
    priority: "required_now",
    implementation_notes: "New external_export importer kind needed — do not reuse product_prices for unit COGS.",
  },
  {
    source_name: "ORBIT/FRA workbook",
    amazon_report_name: "ORBIT/FRA Fight List XLSX",
    sp_api_report_type: null,
    current_table: null,
    report_type: null,
    importer_supported: "no",
    api_automation: "no",
    ui_upload_suitable: "no",
    required_columns: ["FNSKU", "ASIN", "MSKU", "Units Affected", "COGS/Unit", "Recovery Value", "Reference ID", "Source Report"],
    date_range_needed: "Derived from underlying Amazon sources",
    lifecycle_states: ["computed fight list"],
    claim_families: ["ORBIT/FRA fight list"],
    current_blocker: "XLSX import not built; live generator reads DB tables only",
    priority: "later",
    implementation_notes: "claim-orbit-fra-generator.ts is derived output — not primary raw source.",
  },
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function freshness(lastAt: string | null, rowCount: number): SourcePlanRow["freshness"] {
  if (rowCount === 0) return "missing";
  if (!lastAt) return "unknown";
  const ms = Date.now() - new Date(lastAt).getTime();
  return ms > STALE_DAYS * 86_400_000 ? "stale" : "fresh";
}

function classifyRow(row: Omit<SourcePlanRow, "classification">): Classification[] {
  const out: Classification[] = [];
  const registryKind = row.report_type && row.report_type in AMAZON_REPORT_REGISTRY;
  const classified = row.report_type && (CLASSIFIED_REPORT_TYPES as readonly string[]).includes(row.report_type);

  if (row.row_count > 0 && row.freshness === "fresh") out.push("already_imported_usable");
  if (row.row_count > 0 && row.freshness === "stale") out.push("imported_stale");
  if (row.row_count === 0 && row.current_table) out.push("imported_empty");

  if (row.importer_supported === "yes" || (classified && registryKind)) out.push("file_import_supported");
  if (row.importer_supported === "no" && row.source_name !== "ORBIT/FRA workbook") {
    if (!row.current_table) out.push("file_import_missing");
  }
  if (row.importer_supported === "partial") out.push("file_import_supported");

  if (row.api_automation === "yes" || row.api_automation === "partial") out.push("api_sync_available");
  if (row.api_automation === "no" && row.sp_api_report_type && !SP_API_REPORT_TYPE_TO_SYNC_KIND[row.sp_api_report_type]) {
    out.push("api_sync_missing");
  }
  if (row.api_automation === "no" && !row.sp_api_report_type && row.source_name !== "SellerSnap COGS export") {
    out.push("api_sync_missing");
  }
  if (row.priority === "later" || row.priority === "optional") out.push("later_only");

  return [...new Set(out)];
}

async function auditTable(
  c: pg.Client,
  table: string,
  storeScoped: boolean,
  reportType: string | null,
): Promise<{ row_count: number; last_import_at: string | null; last_row_at: string | null }> {
  const exists = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  if (!exists.rows[0]?.ok) return { row_count: 0, last_import_at: null, last_row_at: null };

  const scope = storeScoped
    ? `organization_id = '${ORG}'::uuid AND store_id = '${STORE}'::uuid`
    : `organization_id = '${ORG}'::uuid`;
  const r = await c.query(
    `SELECT COUNT(*)::bigint AS c, MAX(created_at)::text AS last_created FROM public.${table} WHERE ${scope}`,
  );
  let lastImport: string | null = null;
  if (reportType) {
    const u = await c.query(
      `SELECT MAX(created_at)::text AS t FROM public.raw_report_uploads WHERE organization_id = $1::uuid AND report_type = $2`,
      [ORG, reportType],
    );
    lastImport = u.rows[0]?.t ?? null;
  }
  return {
    row_count: Number(r.rows[0]?.c ?? 0),
    last_import_at: lastImport,
    last_row_at: r.rows[0]?.last_created ?? null,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url?.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  await c.query("SET default_transaction_read_only = ON");

  const source_import_api_matrix: SourcePlanRow[] = [];

  for (const spec of SPECS) {
    let stats = { row_count: 0, last_import_at: null as string | null, last_row_at: null as string | null };
    if (spec.current_table) {
      const storeScoped =
        spec.current_table !== "amazon_inventory_ledger" && spec.current_table !== "product_prices";
      stats = await auditTable(c, spec.current_table, storeScoped, spec.report_type);
    }

    const fresh = freshness(stats.last_import_at ?? stats.last_row_at, stats.row_count);
    let blocker = spec.current_blocker;
    if (spec.source_name === "SAFE-T Claims" && stats.row_count === 0) {
      blocker = "EMPTY — Maysam recent 6–7mo file empty; 0 domain rows; source unavailable until non-empty upload";
    } else if (stats.row_count === 0 && spec.priority !== "later" && spec.priority !== "optional") {
      blocker = `EMPTY — 0 rows; ${spec.current_blocker}`;
    } else if (fresh === "stale" && stats.row_count > 0) {
      blocker = `STALE — last ${stats.last_import_at ?? stats.last_row_at}; ${spec.current_blocker}`;
    }

    const base = {
      ...spec,
      ...stats,
      freshness: fresh,
      current_blocker: blocker,
    };
    source_import_api_matrix.push({
      ...base,
      classification: classifyRow(base),
    });
  }

  await c.end();

  const file_upload_candidates = source_import_api_matrix.filter((r) =>
    r.classification.includes("file_import_supported"),
  );
  const api_sync_candidates = source_import_api_matrix.filter((r) =>
    r.classification.includes("api_sync_available"),
  );
  const missing_importers = source_import_api_matrix.filter((r) =>
    r.classification.includes("file_import_missing"),
  );
  const stale_or_empty_sources = source_import_api_matrix.filter(
    (r) => r.classification.includes("imported_stale") || r.classification.includes("imported_empty"),
  );

  const exact_files_maysam_should_download_next = source_import_api_matrix
    .filter(
      (r) =>
        r.priority === "required_now" &&
        (r.row_count === 0 || r.freshness === "stale") &&
        r.ui_upload_suitable !== "no",
    )
    .map((r) => ({
      source: r.source_name,
      amazon_report: r.amazon_report_name,
      date_range: r.date_range_needed,
      reason: r.current_blocker,
      upload_path: "Settings → Imports → UniversalImporter",
    }));

  const exact_sources_to_enable_api_next = source_import_api_matrix
    .filter((r) => r.api_automation === "yes" || r.api_automation === "partial")
    .map((r) => ({
      source: r.source_name,
      sp_api: r.sp_api_report_type,
      env_flags: apiFlagsFor(r.report_type),
      action:
        r.freshness === "stale" || r.source_name === "Reimbursements" || r.source_name === "Settlements"
          ? "Platform Settings → Automation → enable schedule + Run Now"
          : "Verify schedule enabled (removal already live)",
    }));

  const priority_order_for_claim_delivery = [
    ...source_import_api_matrix.filter((r) => r.priority === "required_now").map((r) => r.source_name),
    ...source_import_api_matrix.filter((r) => r.priority === "required_next").map((r) => r.source_name),
    ...source_import_api_matrix.filter((r) => r.priority === "later").map((r) => r.source_name),
  ];

  const UI_upload_design_later = [
    "Batch upload queue with report_type auto-detect (existing ColumnMappingModal)",
    "Per-source freshness badge on Settings→Imports history",
    "SellerSnap COGS dedicated upload card (external_export) separate from Amazon reports",
    "Stranded Inventory: add STRANDED_INVENTORY sync kind before UI promises stranded qty",
    "SAFE-T: show 'Source unavailable' when upload parses 0 data rows — do not write zero counters",
    "Maysam checklist panel in Claim Center Sources (connector_readiness already live)",
  ];

  const SAFE_TO_IMPLEMENT_SOURCE_IMPORT_UI =
    file_upload_candidates.length >= 10 ? "yes" : "partial";
  const SAFE_TO_IMPLEMENT_API_SYNC_NEXT =
    api_sync_candidates.some((r) => r.source_name === "Reimbursements") &&
    api_sync_candidates.some((r) => r.source_name === "Settlements")
      ? "yes"
      : "partial";

  const NEXT_EXACT_PROMPT = `PHASE-MAYSAM-SOURCE-ACQUISITION-EXECUTE-V1 — Maysam: (1) re-attempt SAFE-T alternate date window if recent empty; (2) upload Inventory Ledger + Settlements + Reimbursements refresh; (3) enable Reimbursements+Settlements API Run Now; then PHASE-CLAIM-POOL-EMIT-DRYRUN-V2`;

  const summary = {
    prompt: "PHASE-AMAZON-CLAIM-SOURCE-IMPORT-AND-API-PLAN-V1",
    run_id: rid,
    staging_ref: STAGING_REF,
    mode: "read_only",
    source_import_api_matrix,
    file_upload_candidates: file_upload_candidates.map((r) => r.source_name),
    api_sync_candidates: api_sync_candidates.map((r) => ({
      name: r.source_name,
      api: r.api_automation,
      sp_api: r.sp_api_report_type,
    })),
    missing_importers: missing_importers.map((r) => ({
      name: r.source_name,
      blocker: r.current_blocker,
      notes: r.implementation_notes,
    })),
    stale_or_empty_sources: stale_or_empty_sources.map((r) => ({
      name: r.source_name,
      row_count: r.row_count,
      freshness: r.freshness,
      blocker: r.current_blocker,
    })),
    exact_files_maysam_should_download_next,
    exact_sources_to_enable_api_next,
    UI_upload_design_later,
    priority_order_for_claim_delivery,
    stranded_inventory_codebase_path: {
      sp_api_type: "GET_STRANDED_INVENTORY_UI_DATA",
      registry_entry: "none — not in AMAZON_REPORT_REGISTRY or CLASSIFIED_REPORT_TYPES",
      proxy_table: "amazon_fba_inventory (alert, recommended_action, estimated_excess_quantity)",
      lifecycle_readmodel: "stranded → confidence unavailable until normalized import",
      required_work: "Add STRANDED_INVENTORY sync kind + amazon_stranded_inventory table + header rules",
    },
    safet_special: {
      staging_row_count: source_import_api_matrix.find((r) => r.source_name === "SAFE-T Claims")?.row_count ?? 0,
      maysam_recent_file: "empty",
      behavior: "source unavailable not zero — unreimbursed_gap and safet generators blocked",
      importer: "SAFET_CLAIMS live in registry; upload when non-empty file obtained",
    },
    sellersnap_cogs_special: {
      current_table: "product_prices",
      authority: "NOT COGS — sale/listing context only",
      required: "Dedicated SellerSnap CSV importer → cogs spine (future product_unit_costs or metadata contract)",
    },
    orbit_fra_special: {
      primary: "derived — lib/claims/intake/claim-orbit-fra-generator.ts over DB tables",
      xlsx_import: "blocked_not_built",
      role: "audit workbook / fight list export — not raw ingestion",
    },
    SAFE_TO_IMPLEMENT_SOURCE_IMPORT_UI,
    SAFE_TO_IMPLEMENT_API_SYNC_NEXT,
    NEXT_EXACT_PROMPT,
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "import-api-plan.md"),
    renderMarkdown(summary),
    "utf8",
  );
  fs.writeFileSync(path.join(outDir, "NEXT_EXACT_PROMPT.txt"), NEXT_EXACT_PROMPT);

  console.log(JSON.stringify(summary, null, 2));
}

function apiFlagsFor(reportType: string | null): string[] {
  switch (reportType) {
    case "REMOVAL_ORDER":
      return ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER"];
    case "REMOVAL_SHIPMENT":
      return ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT"];
    case "REIMBURSEMENTS":
      return ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS"];
    case "SETTLEMENT":
      return ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_SETTLEMENT"];
    default:
      return [];
  }
}

function renderMarkdown(summary: Record<string, unknown>): string {
  const matrix = summary.source_import_api_matrix as SourcePlanRow[];
  const lines = [
    "# Amazon claim source import + API plan V1",
    "",
    `**Run:** ${summary.run_id}`,
    "",
    "## Priority order for claim delivery",
    "",
    ...(summary.priority_order_for_claim_delivery as string[]).map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Maysam download next",
    "",
    ...(summary.exact_files_maysam_should_download_next as Array<{ source: string; reason: string }>).map(
      (r) => `- **${r.source}** — ${r.reason}`,
    ),
    "",
    "## Enable API next",
    "",
    ...(summary.exact_sources_to_enable_api_next as Array<{ source: string; action: string }>).map(
      (r) => `- **${r.source}** — ${r.action}`,
    ),
    "",
    "## SAFE-T",
    "",
    `- ${JSON.stringify(summary.safet_special)}`,
    "",
    "## Stranded inventory",
    "",
    `- ${JSON.stringify(summary.stranded_inventory_codebase_path)}`,
    "",
    "## Matrix (condensed)",
    "",
    "| Source | Table | Rows | Fresh | Importer | API | Priority |",
    "|--------|-------|------|-------|----------|-----|----------|",
    ...matrix.map(
      (r) =>
        `| ${r.source_name} | ${r.current_table ?? "—"} | ${r.row_count} | ${r.freshness} | ${r.importer_supported} | ${r.api_automation} | ${r.priority} |`,
    ),
  ];
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
