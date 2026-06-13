/**
 * PHASE-AMAZON-CLAIM-SOURCE-ACQUISITION-CHECKLIST-V1
 * Read-only — Maysam acquisition guidance; no DB writes.
 *
 *   npx tsx scripts/phase-amazon-claim-source-acquisition-checklist-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-claim-source-acquisition-checklist-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const STALE_DAYS = 45;
/** ORBIT / dispute windows + SAFE-T recent window Maysam mentioned */
const REQUIRED_MONTHS = 7;

type Priority = "required_now" | "required_next" | "later" | "optional";

type AcquisitionRow = {
  source_name: string;
  amazon_report_api_name: string;
  seller_central_download_path: string;
  domain_table: string | null;
  report_type: string | null;
  system_imports: "yes" | "no" | "partial";
  api_automation: "yes" | "no" | "partial";
  api_automation_detail: string;
  required_date_range: string;
  required_columns: string[];
  lifecycle_states: string[];
  claim_families: string[];
  row_count: number;
  last_import_at: string | null;
  last_row_at: string | null;
  freshness: "fresh" | "stale" | "missing" | "unknown";
  current_blocker: string;
  priority: Priority;
  acquisition_mode: "api" | "file_only" | "scanner" | "external_export" | "planned";
};

const MATRIX: Omit<
  AcquisitionRow,
  "row_count" | "last_import_at" | "last_row_at" | "freshness" | "system_imports"
>[] = [
  {
    source_name: "Physical return scanner",
    amazon_report_api_name: "N/A — warehouse scanner",
    seller_central_download_path: "N/A — operator mobile scan flow",
    domain_table: "return_items",
    report_type: null,
    api_automation: "no",
    api_automation_detail: "Scanner app only",
    required_date_range: "Rolling 90d intake window",
    required_columns: ["fnsku", "asin", "sku", "package_id", "notes", "conditions"],
    lifecycle_states: ["detected", "needs_review", "proof", "ready_to_file"],
    claim_families: ["physical_return_issue", "physical_return_off_manifest", "physical_return_damaged"],
    current_blocker: "SellerSnap COGS not wired for recovery_value",
    priority: "required_now",
    acquisition_mode: "scanner",
  },
  {
    source_name: "FBA Customer Returns",
    amazon_report_api_name: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA (file typical)",
    seller_central_download_path: "Reports → Fulfillment → FBA customer returns",
    domain_table: "amazon_returns",
    report_type: "FBA_RETURNS",
    api_automation: "no",
    api_automation_detail: "UniversalImporter file sync only",
    required_date_range: `Last ${REQUIRED_MONTHS} months minimum`,
    required_columns: ["return-date", "order-id", "sku", "asin", "fnsku", "quantity", "reason", "disposition"],
    lifecycle_states: ["detected", "needs_review", "blocked_product_link"],
    claim_families: ["customer_return_not_reimbursed", "delayed_not_received", "orbit_fra return categories"],
    current_blocker: "Last file import 2026-04-15; no API pull",
    priority: "required_next",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Inventory Ledger",
    amazon_report_api_name: "GET_LEDGER_DETAIL_VIEW_DATA / Inventory Ledger flat file",
    seller_central_download_path: "Reports → Fulfillment → Inventory → Inventory Ledger",
    domain_table: "amazon_inventory_ledger",
    report_type: "INVENTORY_LEDGER",
    api_automation: "no",
    api_automation_detail: "File import only",
    required_date_range: "18 months (ORBIT 545d window); min 7 months refresh",
    required_columns: ["date", "fnsku", "asin", "msku", "reference-id", "reason", "event-type", "quantity", "unreconciled-quantity"],
    lifecycle_states: ["detected", "find_money", "needs_review"],
    claim_families: ["inventory_lost_damaged", "disposed_without_reimbursement", "inventory_unreconciled_loss", "warehouse_lost", "warehouse_damaged", "destroyed_without_permission"],
    current_blocker: "Data ends 2026-04-24; reference_id only 5% populated",
    priority: "required_now",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Removal Order Detail",
    amazon_report_api_name: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
    seller_central_download_path: "Reports → Fulfillment → Removals → Removal order detail",
    domain_table: "amazon_removals",
    report_type: "REMOVAL_ORDER",
    api_automation: "yes",
    api_automation_detail: "SP-API removal_api_sync + file import",
    required_date_range: `Last ${REQUIRED_MONTHS} months`,
    required_columns: ["order-id", "sku", "fnsku", "requested-quantity", "shipped-quantity", "disposed-quantity", "order-date", "removal-fee"],
    lifecycle_states: ["detected", "needs_review", "proof"],
    claim_families: ["removal_discrepancy", "removal_missing_units"],
    current_blocker: "None critical — refresh through 2026-05-31",
    priority: "required_next",
    acquisition_mode: "api",
  },
  {
    source_name: "Removal Shipment Detail",
    amazon_report_api_name: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
    seller_central_download_path: "Reports → Fulfillment → Removals → Removal shipment detail",
    domain_table: "amazon_removal_shipments",
    report_type: "REMOVAL_SHIPMENT",
    api_automation: "yes",
    api_automation_detail: "SP-API removal_api_sync + file import",
    required_date_range: `Last ${REQUIRED_MONTHS} months`,
    required_columns: ["order-id", "sku", "fnsku", "tracking-number", "carrier", "shipment-date", "shipped-quantity"],
    lifecycle_states: ["detected", "needs_review", "proof"],
    claim_families: ["removal_shipped_vs_detail_mismatch", "shipment_discrepancy"],
    current_blocker: "None critical",
    priority: "required_next",
    acquisition_mode: "api",
  },
  {
    source_name: "Reimbursements",
    amazon_report_api_name: "GET_FBA_REIMBURSEMENTS_DATA",
    seller_central_download_path: "Reports → Fulfillment → Reimbursements",
    domain_table: "amazon_reimbursements",
    report_type: "REIMBURSEMENTS",
    api_automation: "partial",
    api_automation_detail: "reimbursements_api schedule exists; file import primary",
    required_date_range: `Last ${REQUIRED_MONTHS} months`,
    required_columns: ["reimbursement-id", "order-id", "sku", "amount-reimbursed", "reason"],
    lifecycle_states: ["recovery", "filed", "reimbursed"],
    claim_families: ["reimbursement_verification", "reimbursement_reversal"],
    current_blocker: "Domain rows stale 2026-04-14 vs upload 2026-06-01",
    priority: "required_now",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Transactions",
    amazon_report_api_name: "Settlement flat file / Simple Transactions Summary",
    seller_central_download_path: "Reports → Payments → Transaction View → Download",
    domain_table: "amazon_transactions",
    report_type: "TRANSACTIONS",
    api_automation: "no",
    api_automation_detail: "File import only",
    required_date_range: `Last ${REQUIRED_MONTHS} months`,
    required_columns: ["date", "transaction-type", "order-id", "sku", "total"],
    lifecycle_states: ["detected", "needs_review"],
    claim_families: ["settlement_refund_anomaly", "transaction_negative_adjustment"],
    current_blocker: "SKU column empty on all rows",
    priority: "required_next",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Settlements",
    amazon_report_api_name: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE",
    seller_central_download_path: "Reports → Payments → All Statements → Download flat file",
    domain_table: "amazon_settlements",
    report_type: "SETTLEMENT",
    api_automation: "partial",
    api_automation_detail: "settlement_api schedule + file import",
    required_date_range: `Last ${REQUIRED_MONTHS} months`,
    required_columns: ["settlement-id", "posted-date", "order-id", "sku", "amount-type", "amount", "transaction-type"],
    lifecycle_states: ["detected", "needs_review", "recovery"],
    claim_families: ["settlement_refund_anomaly", "settlement_refund_review"],
    current_blocker: "Ends 2026-04-24 — needs refresh",
    priority: "required_now",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Reports Repository",
    amazon_report_api_name: "N/A — upload archive",
    seller_central_download_path: "Any report → upload via Settings → Imports",
    domain_table: "raw_report_uploads",
    report_type: null,
    api_automation: "no",
    api_automation_detail: "Evidence lineage only",
    required_date_range: "Match each claim window",
    required_columns: ["file_name", "report_type", "upload metadata"],
    lifecycle_states: ["proof", "evidence"],
    claim_families: ["all — evidence/source report edges"],
    current_blocker: "None",
    priority: "optional",
    acquisition_mode: "file_only",
  },
  {
    source_name: "SAFE-T Claims",
    amazon_report_api_name: "SAFE-T reimbursement report (file)",
    seller_central_download_path: "Reports → Fulfillment → SAFE-T reimbursement OR Payments → SAFE-T",
    domain_table: "amazon_safet_claims",
    report_type: "SAFET_CLAIMS",
    api_automation: "no",
    api_automation_detail: "File import only — no rows on staging",
    required_date_range: `Last ${REQUIRED_MONTHS} months (Maysam: recent window empty)`,
    required_columns: ["SAFE-T Claim ID", "Order ID", "ASIN", "Claim Reason", "Claim Status", "Reimbursement Amount", "Claim Date"],
    lifecycle_states: ["detected", "needs_review", "filed"],
    claim_families: ["safet_claims", "safet_followup"],
    current_blocker: "EMPTY — 0 rows imported",
    priority: "required_now",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Manage FBA Inventory / Restock",
    amazon_report_api_name: "GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT / Manage FBA Inventory",
    seller_central_download_path: "Reports → Fulfillment → Inventory → Restock Inventory / Manage FBA Inventory",
    domain_table: "amazon_manage_fba_inventory",
    report_type: "MANAGE_FBA_INVENTORY",
    api_automation: "no",
    api_automation_detail: "File import only",
    required_date_range: "Current snapshot + monthly history",
    required_columns: ["sku", "fnsku", "asin", "afn-fulfillable-quantity", "afn-reserved-quantity", "afn-unfulfillable-quantity"],
    lifecycle_states: ["detected"],
    claim_families: ["fba_available_reserved_stranded_inventory"],
    current_blocker: "Generator not wired for claim pool",
    priority: "later",
    acquisition_mode: "file_only",
  },
  {
    source_name: "FBA Inventory (Inventory Health)",
    amazon_report_api_name: "GET_FBA_INVENTORY_AGED_DATA / Inventory Health",
    seller_central_download_path: "Reports → Fulfillment → Inventory → FBA Inventory",
    domain_table: "amazon_fba_inventory",
    report_type: "FBA_INVENTORY",
    api_automation: "no",
    api_automation_detail: "File import only",
    required_date_range: "Current + aged inventory windows",
    required_columns: ["sku", "fnsku", "asin", "estimated-storage-cost-next-month", "no-sale-last-6-months", "unfulfillable-quantity"],
    lifecycle_states: ["detected"],
    claim_families: ["expired_inventory", "fba_available_reserved_stranded_inventory"],
    current_blocker: "Generator not wired",
    priority: "later",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Reserved Inventory",
    amazon_report_api_name: "Reserved Inventory report",
    seller_central_download_path: "Reports → Fulfillment → Inventory → Reserved Inventory",
    domain_table: "amazon_reserved_inventory",
    report_type: "RESERVED_INVENTORY",
    api_automation: "no",
    api_automation_detail: "File import only",
    required_date_range: "Current snapshot",
    required_columns: ["sku", "fnsku", "asin", "reserved-quantity"],
    lifecycle_states: ["detected"],
    claim_families: ["fba_available_reserved_stranded_inventory"],
    current_blocker: "Generator not wired",
    priority: "later",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Stranded Inventory",
    amazon_report_api_name: "Stranded inventory / listing fix reports",
    seller_central_download_path: "Inventory → Fix stranded inventory OR Reports → Inventory",
    domain_table: null,
    report_type: null,
    api_automation: "no",
    api_automation_detail: "No dedicated table — use FBA Inventory + listing reports",
    required_date_range: "Current",
    required_columns: ["sku", "asin", "stranded-reason"],
    lifecycle_states: ["detected"],
    claim_families: ["fba_available_reserved_stranded_inventory"],
    current_blocker: "No import table in system",
    priority: "later",
    acquisition_mode: "planned",
  },
  {
    source_name: "Inbound Performance",
    amazon_report_api_name: "Inbound performance / shipment problems",
    seller_central_download_path: "Reports → Fulfillment → Inbound performance",
    domain_table: "amazon_inbound_performance",
    report_type: "INBOUND_PERFORMANCE",
    api_automation: "no",
    api_automation_detail: "File import only",
    required_date_range: `Last ${REQUIRED_MONTHS} months`,
    required_columns: ["fba-shipment-id", "sku", "fnsku", "problem-type", "problem-quantity", "expected-quantity", "received-quantity"],
    lifecycle_states: ["detected", "needs_review"],
    claim_families: ["inbound_shipment_discrepancy", "inbound_shipment_shortage"],
    current_blocker: "Check row count at audit",
    priority: "required_next",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Shipment Reconciliation",
    amazon_report_api_name: "FBA inbound shipment reconciliation (if exported)",
    seller_central_download_path: "Shipping Queue → Shipment contents / Reconciliation exports",
    domain_table: null,
    report_type: null,
    api_automation: "no",
    api_automation_detail: "Partial via expected_packages + inbound_performance",
    required_date_range: `Last ${REQUIRED_MONTHS} months`,
    required_columns: ["shipment-id", "sku", "expected", "received"],
    lifecycle_states: ["detected", "proof"],
    claim_families: ["inbound_shipment_discrepancy", "shipment_discrepancy"],
    current_blocker: "No dedicated table",
    priority: "later",
    acquisition_mode: "planned",
  },
  {
    source_name: "FBA Fee Preview",
    amazon_report_api_name: "Fee Preview report",
    seller_central_download_path: "Reports → Fulfillment → Fee Preview",
    domain_table: "amazon_fee_preview",
    report_type: "FEE_PREVIEW",
    api_automation: "no",
    api_automation_detail: "File import only",
    required_date_range: "Current catalog snapshot",
    required_columns: ["sku", "fnsku", "asin", "estimated-fee-total", "expected-fulfillment-fee-per-unit"],
    lifecycle_states: ["detected"],
    claim_families: ["fee_dimension_overcharge"],
    current_blocker: "Needs product_packaging_dimensions_current for compare",
    priority: "later",
    acquisition_mode: "file_only",
  },
  {
    source_name: "Monthly Storage Fees",
    amazon_report_api_name: "GET_FBA_STORAGE_FEE_CHARGES_DATA",
    seller_central_download_path: "Reports → Fulfillment → Payments → Monthly storage fees",
    domain_table: "amazon_monthly_storage_fees",
    report_type: "MONTHLY_STORAGE_FEES",
    api_automation: "no",
    api_automation_detail: "File import only",
    required_date_range: "Last 12 months",
    required_columns: ["asin", "fnsku", "sku", "storage-month", "storage-rate", "estimated-monthly-storage-fee"],
    lifecycle_states: ["detected"],
    claim_families: ["storage_fee_issue"],
    current_blocker: "Generator not wired",
    priority: "later",
    acquisition_mode: "file_only",
  },
  {
    source_name: "SellerSnap COGS export",
    amazon_report_api_name: "N/A — SellerSnap export",
    seller_central_download_path: "SellerSnap → Export COGS / cost file",
    domain_table: "product_prices",
    report_type: null,
    api_automation: "no",
    api_automation_detail: "NOT WIRED — no SellerSnap connector",
    required_date_range: "Current cost per SKU/ASIN",
    required_columns: ["sku", "asin", "unit_cost", "effective_date"],
    lifecycle_states: ["find_money", "detected"],
    claim_families: ["product_cost_cogs", "all ORBIT recovery_value families"],
    current_blocker: "SellerSnap not imported; recovery_value = COGS_MISSING",
    priority: "required_now",
    acquisition_mode: "external_export",
  },
  {
    source_name: "ORBIT/FRA Fight List workbook",
    amazon_report_api_name: "N/A — internal ORBIT XLSX",
    seller_central_download_path: "Internal ORBIT/FRA spreadsheet (not Seller Central)",
    domain_table: null,
    report_type: null,
    api_automation: "no",
    api_automation_detail: "Live generator over DB tables; XLSX import blocked",
    required_date_range: "Match ORBIT category windows (up to 545d)",
    required_columns: ["FNSKU", "ASIN", "MSKU", "Units Affected", "COGS/Unit", "Recovery Value", "Reference ID", "Source Report"],
    lifecycle_states: ["detected", "needs_review", "find_money"],
    claim_families: ["orbit_fra_recovery", "all 18 ORBIT categories"],
    current_blocker: "XLSX import not built; depends on sources above",
    priority: "required_next",
    acquisition_mode: "planned",
  },
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function freshness(lastAt: string | null, rowCount: number): AcquisitionRow["freshness"] {
  if (rowCount === 0) return "missing";
  if (!lastAt) return "unknown";
  const ms = Date.now() - new Date(lastAt).getTime();
  return ms > STALE_DAYS * 86_400_000 ? "stale" : "fresh";
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  return Boolean(r.rows[0]?.ok);
}

async function auditTable(
  c: pg.Client,
  table: string,
  storeScoped: boolean,
  reportType: string | null,
): Promise<{ row_count: number; last_import_at: string | null; last_row_at: string | null }> {
  if (!(await tableExists(c, table))) {
    return { row_count: 0, last_import_at: null, last_row_at: null };
  }
  const scope = storeScoped
    ? `organization_id = '${ORG}'::uuid AND store_id = '${STORE}'::uuid`
    : `organization_id = '${ORG}'::uuid`;
  const r = await c.query(`
    SELECT COUNT(*)::bigint AS c, MAX(created_at)::text AS last_created
    FROM public.${table} WHERE ${scope}
  `);
  let lastImport: string | null = null;
  if (reportType) {
    const u = await c.query(
      `SELECT MAX(created_at)::text AS t FROM public.raw_report_uploads
       WHERE organization_id = $1::uuid AND report_type = $2`,
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
  await c.query("SET default_transaction_read_only = on");

  const source_acquisition_matrix: AcquisitionRow[] = [];

  for (const spec of MATRIX) {
    let stats = { row_count: 0, last_import_at: null as string | null, last_row_at: null as string | null };
    if (spec.domain_table) {
      const storeScoped = spec.domain_table !== "raw_report_uploads" && spec.domain_table !== "product_prices";
      stats = await auditTable(c, spec.domain_table, storeScoped, spec.report_type);
    }
    const fresh = freshness(stats.last_import_at ?? stats.last_row_at, stats.row_count);
    let system_imports: AcquisitionRow["system_imports"] = "no";
    if (stats.row_count > 0) system_imports = fresh === "stale" ? "partial" : "yes";

    let blocker = spec.current_blocker;
    if (stats.row_count === 0 && spec.priority !== "optional") {
      blocker = `EMPTY — 0 rows; ${spec.current_blocker}`;
    } else if (fresh === "stale" && stats.row_count > 0) {
      blocker = `STALE — last activity ${stats.last_import_at ?? stats.last_row_at}; ${spec.current_blocker}`;
    }

    source_acquisition_matrix.push({
      ...spec,
      ...stats,
      freshness: fresh,
      system_imports,
      current_blocker: blocker,
    });
  }

  await c.end();

  const already_imported_sources = source_acquisition_matrix
    .filter((r) => r.system_imports === "yes" || r.system_imports === "partial")
    .map((r) => r.source_name);
  const empty_sources = source_acquisition_matrix.filter((r) => r.row_count === 0).map((r) => r.source_name);
  const stale_sources = source_acquisition_matrix.filter((r) => r.freshness === "stale").map((r) => r.source_name);
  const missing_sources = source_acquisition_matrix
    .filter((r) => r.freshness === "missing" && r.priority !== "optional")
    .map((r) => r.source_name);
  const api_available_sources = source_acquisition_matrix
    .filter((r) => r.api_automation === "yes" || r.api_automation === "partial")
    .map((r) => r.source_name);
  const file_only_sources = source_acquisition_matrix
    .filter((r) => r.acquisition_mode === "file_only" || r.acquisition_mode === "external_export")
    .map((r) => r.source_name);

  const exact_reports_maysam_should_download_now = source_acquisition_matrix
    .filter((r) => r.priority === "required_now" && (r.row_count === 0 || r.freshness === "stale"))
    .map((r) => ({
      source: r.source_name,
      seller_central: r.seller_central_download_path,
      date_range: r.required_date_range,
      reason: r.current_blocker,
    }));

  const exact_reports_to_enable_api_next = source_acquisition_matrix
    .filter((r) => r.api_automation === "partial" || (r.api_automation === "yes" && r.freshness === "stale"))
    .map((r) => ({
      source: r.source_name,
      api: r.api_automation_detail,
      action: r.freshness === "stale" ? "Enable schedule + Run Now in Platform Automation" : "Verify schedule enabled",
    }));

  const required_columns_by_report = Object.fromEntries(
    source_acquisition_matrix
      .filter((r) => r.report_type || r.required_columns.length)
      .map((r) => [r.source_name, r.required_columns]),
  );

  const priority_order = [
    ...source_acquisition_matrix.filter((r) => r.priority === "required_now").map((r) => r.source_name),
    ...source_acquisition_matrix.filter((r) => r.priority === "required_next").map((r) => r.source_name),
    ...source_acquisition_matrix.filter((r) => r.priority === "later").map((r) => r.source_name),
    ...source_acquisition_matrix.filter((r) => r.priority === "optional").map((r) => r.source_name),
  ];

  const blockersForDisplay = [
    empty_sources.includes("SAFE-T Claims") ? "SAFE-T empty" : null,
    stale_sources.length ? `${stale_sources.length} stale sources` : null,
    "SellerSnap COGS not wired",
    "Product linkage 49.1%",
  ].filter(Boolean);

  const summary = {
    phase: "PHASE-AMAZON-CLAIM-SOURCE-ACQUISITION-CHECKLIST-V1",
    run_id: rid,
    mode: "read-only",
    staging_ref: STAGING_REF,
    org_id: ORG,
    store_id: STORE,
    source_acquisition_matrix,
    already_imported_sources,
    empty_sources,
    stale_sources,
    missing_sources,
    api_available_sources,
    file_only_sources,
    exact_reports_maysam_should_download_now,
    exact_reports_to_enable_api_next,
    required_columns_by_report,
    priority_order,
    SAFE_TO_USE_CURRENT_DATA_FOR_CLAIM_DISPLAY: blockersForDisplay.length <= 2 ? "partial_yes" : "no",
    SAFE_TO_USE_CURRENT_DATA_FOR_CLAIM_DISPLAY_note:
      "Physical return MVP + removal APIs OK for limited display; money/COGS/SAFE-T/settlement refresh blocked",
    NEXT_EXACT_PROMPT:
      "PHASE-MAYSAM-SOURCE-ACQUISITION-EXECUTE-V1 — Maysam downloads SAFE-T (7mo) + Inventory Ledger + Settlements + Reimbursements refresh; upload via Settings→Imports; then PHASE-CLAIM-POOL-EMIT-DRYRUN-V2",
    blockers: blockersForDisplay,
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  const md = `# Amazon claim source acquisition checklist V1

| Field | Value |
|-------|-------|
| run_id | ${rid} |
| SAFE_TO_USE_CURRENT_DATA_FOR_CLAIM_DISPLAY | **${summary.SAFE_TO_USE_CURRENT_DATA_FOR_CLAIM_DISPLAY}** |

## Maysam — download NOW

${exact_reports_maysam_should_download_now
  .map((x) => `- **${x.source}** — ${x.seller_central} (${x.date_range})`)
  .join("\n")}

## Enable API next

${exact_reports_to_enable_api_next.map((x) => `- **${x.source}** — ${x.action}`).join("\n")}

## Empty sources

${empty_sources.map((s) => `- ${s}`).join("\n")}

## Stale sources

${stale_sources.map((s) => `- ${s}`).join("\n")}

## Priority order

${priority_order.map((s, i) => `${i + 1}. ${s}`).join("\n")}
`;
  fs.writeFileSync(path.join(outDir, "acquisition-checklist.md"), md);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
