/**
 * PHASE-4B-API-AUTOMATION-GAP-AUDIT (read-only)
 *   npx tsx scripts/phase4b-api-automation-gap-audit-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { readStoreAutomationSettings } from "../lib/platform-automation-scope-storage";
import {
  computeApiCardNextRun,
  computeProductEnrichmentNextRun,
  computeRemovalRecentNextRun,
} from "../lib/platform-automation-schedule";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type ApiRow = {
  api: string;
  raw_table: string;
  raw_table_exists: boolean;
  domain_row_count: number | null;
  parser: string;
  manual_import: string;
  api_worker: string;
  schedule_key: string | null;
  schedule_enabled: boolean | null;
  scheduled_executor: string;
  credentials: string;
  last_success_at: string | null;
  last_success_source: string | null;
  next_run_at: string | null;
  derived_rebuild: string;
  health_card: string;
  staging_original_parity: string;
  blocker: string;
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [name],
  );
  return r.rowCount !== null && r.rowCount > 0;
}

async function countTable(client: pg.Client, table: string): Promise<number | null> {
  if (!(await tableExists(client, table))) return null;
  const r = await client.query(
    `SELECT COUNT(*)::text AS c FROM public.${table} WHERE organization_id=$1::uuid`,
    [ORG],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function lastUploadSuccess(
  client: pg.Client,
  reportTypes: string[],
): Promise<{ at: string | null; type: string | null }> {
  const r = await client.query<{ created_at: string; report_type: string }>(
    `SELECT created_at::text, report_type
     FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid
       AND report_type = ANY($2::text[])
       AND status NOT ILIKE '%fail%'
       AND status NOT ILIKE '%error%'
       AND status <> 'archived_health_demo'
     ORDER BY created_at DESC
     LIMIT 1`,
    [ORG, reportTypes],
  );
  const row = r.rows[0];
  return { at: row?.created_at ?? null, type: row?.report_type ?? null };
}

async function lastFinancesRun(client: pg.Client): Promise<string | null> {
  if (!(await tableExists(client, "amazon_finances_source_runs"))) return null;
  const r = await client.query<{ updated_at: string; state: string }>(
    `SELECT updated_at::text, state
     FROM public.amazon_finances_source_runs
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND state='complete'
     ORDER BY updated_at DESC LIMIT 1`,
    [ORG, STORE],
  );
  return r.rows[0]?.updated_at ?? null;
}

async function lastProductEnrichmentJob(client: pg.Client): Promise<string | null> {
  if (!(await tableExists(client, "jobs"))) return null;
  const r = await client.query<{ completed_at: string }>(
    `SELECT completed_at::text
     FROM public.jobs
     WHERE job_type='product_enrichment'
       AND organization_id=$1::uuid
       AND status='completed'
     ORDER BY completed_at DESC NULLS LAST
     LIMIT 1`,
    [ORG],
  );
  return r.rows[0]?.completed_at ?? null;
}

async function auditDb(label: string, url: string, settingsRaw: unknown) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const settings = readStoreAutomationSettings(settingsRaw, ORG, STORE);
  const now = new Date();
  const nextRuns = {
    product: settings.product_enrichment.enabled
      ? computeProductEnrichmentNextRun(settings.product_enrichment, now)?.toISOString() ?? null
      : null,
    removal: settings.removal_api_sync.enabled
      ? (settings.removal_api_sync.cron_runtime?.next_run_at ??
        computeRemovalRecentNextRun(settings.removal_api_sync, now)?.toISOString() ??
        null)
      : null,
    reimbursements: settings.reimbursements_api.enabled
      ? computeApiCardNextRun(settings.reimbursements_api, now)?.toISOString() ?? null
      : null,
    settlement: settings.settlement_api.enabled
      ? computeApiCardNextRun(settings.settlement_api, now)?.toISOString() ?? null
      : null,
    finances: settings.finances_archive_api.enabled
      ? computeApiCardNextRun(settings.finances_archive_api, now)?.toISOString() ?? null
      : null,
  };

  const removalOrderUp = await lastUploadSuccess(client, ["REMOVAL_ORDER"]);
  const removalShipUp = await lastUploadSuccess(client, ["REMOVAL_SHIPMENT"]);
  const reimbUp = await lastUploadSuccess(client, ["REIMBURSEMENTS", "reimbursements"]);
  const settUp = await lastUploadSuccess(client, ["SETTLEMENT", "settlement_repository"]);
  const ledgerUp = await lastUploadSuccess(client, ["INVENTORY_LEDGER", "inventory_ledger"]);
  const safetUp = await lastUploadSuccess(client, ["SAFET_CLAIMS", "safe_t_claims"]);
  const allOrdersUp = await lastUploadSuccess(client, ["ALL_ORDERS"]);
  const txnUp = await lastUploadSuccess(client, ["TRANSACTIONS", "transaction_view"]);
  const listingUp = await lastUploadSuccess(client, [
    "ALL_LISTINGS",
    "ACTIVE_LISTINGS",
    "CATEGORY_LISTINGS",
    "PRODUCT_IDENTITY",
  ]);

  const removalCronSuccess = settings.removal_api_sync.cron_runtime?.last_success_at ?? null;
  const removalNext = nextRuns.removal;

  const apis: ApiRow[] = [
    {
      api: "Removal Order",
      raw_table: "amazon_removals",
      raw_table_exists: await tableExists(client, "amazon_removals"),
      domain_row_count: await countTable(client, "amazon_removals"),
      parser: "mapRowToAmazonRemoval (import-sync-mappers.ts)",
      manual_import: "file sync + reports-api/removal-order/run",
      api_worker: "reports-api-removal-order-worker.ts",
      schedule_key: "removal_api_sync",
      schedule_enabled: settings.removal_api_sync.enabled,
      scheduled_executor: "vercel cron + removal-automation-orchestrator (staging GHA)",
      credentials: "stores.marketplaces(amazon_sp_api) + ENABLE_AMAZON_REPORTS_API_*",
      last_success_at: removalCronSuccess ?? removalOrderUp.at,
      last_success_source: removalCronSuccess ? "cron_runtime" : removalOrderUp.type,
      next_run_at: removalNext,
      derived_rebuild: "expected_packages resolver scripts",
      health_card: "AutomationApiCenter + production-sync-health",
      staging_original_parity: label === "original" ? "removal parity pack exists" : "GHA orchestrator staging-only",
      blocker:
        settings.removal_api_sync.enabled === false
          ? "schedule disabled in platform_settings"
          : "none (fully wired)",
    },
    {
      api: "Removal Shipment",
      raw_table: "amazon_removal_shipments",
      raw_table_exists: await tableExists(client, "amazon_removal_shipments"),
      domain_row_count: await countTable(client, "amazon_removal_shipments"),
      parser: "mapRowToAmazonRemovalShipment",
      manual_import: "file sync + reports-api/removal-shipment/run",
      api_worker: "reports-api-removal-shipment-worker.ts",
      schedule_key: "removal_api_sync (report_types)",
      schedule_enabled: settings.removal_api_sync.enabled,
      scheduled_executor: "shared removal cron/orchestrator",
      credentials: "same as removal order",
      last_success_at: removalCronSuccess ?? removalShipUp.at,
      last_success_source: removalCronSuccess ? "cron_runtime" : removalShipUp.type,
      next_run_at: removalNext,
      derived_rebuild: "expected_packages Phase 4 generic",
      health_card: "AutomationApiCenter (shared removal runtime)",
      staging_original_parity: "same as removal order",
      blocker: settings.removal_api_sync.enabled === false ? "schedule disabled" : "none",
    },
    {
      api: "Product Data / Catalog",
      raw_table: "amazon_listing_report_rows_raw + catalog_products",
      raw_table_exists: await tableExists(client, "catalog_products"),
      domain_row_count: await countTable(client, "catalog_products"),
      parser: "mapRowToCatalogProduct + listing-import-complete",
      manual_import: "file sync only (listing kinds)",
      api_worker: "product-enrichment-worker (Catalog API enrich, not listing pull)",
      schedule_key: "product_enrichment",
      schedule_enabled: settings.product_enrichment.enabled,
      scheduled_executor: "platform-automation-scheduler-tick (partial; jobs/tick)",
      credentials: "OpenAI org key for enrich; no SP-API listing pull",
      last_success_at: await lastProductEnrichmentJob(client),
      last_success_source: "jobs.product_enrichment",
      next_run_at: nextRuns.product,
      derived_rebuild: "catalog_products + product_identifier_map",
      health_card: "AutomationApiCenter product card (partial)",
      staging_original_parity: "schema parity scripts; no listing API automation parity",
      blocker: "no SP-API listing report worker; schedule ≠ listing pull",
    },
    {
      api: "Reimbursements",
      raw_table: "amazon_reimbursements",
      raw_table_exists: await tableExists(client, "amazon_reimbursements"),
      domain_row_count: await countTable(client, "amazon_reimbursements"),
      parser: "mapRowToAmazonReimbursement",
      manual_import: "file sync + reports-api/run",
      api_worker: "reports-api-reimbursements-worker.ts",
      schedule_key: "reimbursements_api",
      schedule_enabled: settings.reimbursements_api.enabled,
      scheduled_executor: "none (UI schedule only)",
      credentials: "SP-API + ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS",
      last_success_at: reimbUp.at,
      last_success_source: reimbUp.type,
      next_run_at: nextRuns.reimbursements,
      derived_rebuild: "financial_reference_resolver (generic Phase 4)",
      health_card: "AutomationApiCenter + ClaimApiIntakeSettingsPanel",
      staging_original_parity: "mock smoke only; no original automation parity",
      blocker: "schedule UI without cron executor",
    },
    {
      api: "Settlements",
      raw_table: "amazon_settlements",
      raw_table_exists: await tableExists(client, "amazon_settlements"),
      domain_row_count: await countTable(client, "amazon_settlements"),
      parser: "mapRowToAmazonSettlement",
      manual_import: "file sync + reports-api/settlement/run",
      api_worker: "reports-api-settlement-worker.ts",
      schedule_key: "settlement_api",
      schedule_enabled: settings.settlement_api.enabled,
      scheduled_executor: "none (UI schedule only)",
      credentials: "SP-API + ENABLE_AMAZON_REPORTS_API_SETTLEMENT",
      last_success_at: settUp.at,
      last_success_source: settUp.type,
      next_run_at: nextRuns.settlement,
      derived_rebuild: "FRR reconciliation route + financial_reference_resolver",
      health_card: "AutomationApiCenter + claim intake panel",
      staging_original_parity: "staging smoke scripts only",
      blocker: "schedule UI without cron executor",
    },
    {
      api: "Finances / Transactions",
      raw_table: "amazon_finances_* + amazon_transactions",
      raw_table_exists: await tableExists(client, "amazon_finances_source_runs"),
      domain_row_count: await countTable(client, "amazon_transactions"),
      parser: "finances-api-event-* + mapRowToAmazonTransaction",
      manual_import: "finances-api/run (archive) + file sync (transactions CSV)",
      api_worker: "finances-api-ingest-worker.ts",
      schedule_key: "finances_archive_api",
      schedule_enabled: settings.finances_archive_api.enabled,
      scheduled_executor: "none (UI schedule only)",
      credentials: "SP-API + ENABLE_AMAZON_FINANCES_API_*",
      last_success_at: (await lastFinancesRun(client)) ?? txnUp.at,
      last_success_source: (await lastFinancesRun(client)) ? "amazon_finances_source_runs" : txnUp.type,
      next_run_at: nextRuns.finances,
      derived_rebuild: "TRID reference edges (archive); transactions → FRR",
      health_card: "AutomationApiCenter finances card",
      staging_original_parity: "finances staging smoke only",
      blocker: "schedule UI without cron; transactions file-only",
    },
    {
      api: "Inventory Ledger",
      raw_table: "amazon_inventory_ledger",
      raw_table_exists: await tableExists(client, "amazon_inventory_ledger"),
      domain_row_count: await countTable(client, "amazon_inventory_ledger"),
      parser: "mapRowToAmazonInventoryLedger",
      manual_import: "file sync only",
      api_worker: "none",
      schedule_key: null,
      schedule_enabled: null,
      scheduled_executor: "none",
      credentials: "N/A (file upload)",
      last_success_at: ledgerUp.at,
      last_success_source: ledgerUp.type,
      next_run_at: null,
      derived_rebuild: "inventory-ledger-identifier-enrich → product_identifier_map",
      health_card: "none",
      staging_original_parity: "view/schema parity only",
      blocker: "file-only; no API automation path",
    },
    {
      api: "SAFET",
      raw_table: "amazon_safet_claims",
      raw_table_exists: await tableExists(client, "amazon_safet_claims"),
      domain_row_count: await countTable(client, "amazon_safet_claims"),
      parser: "mapRowToAmazonSafetClaim",
      manual_import: "file sync only",
      api_worker: "none",
      schedule_key: null,
      schedule_enabled: null,
      scheduled_executor: "none",
      credentials: "N/A",
      last_success_at: safetUp.at,
      last_success_source: safetUp.type,
      next_run_at: null,
      derived_rebuild: "none (generic_target_table null)",
      health_card: "none",
      staging_original_parity: "unknown",
      blocker: "file-only; no automation surface",
    },
    {
      api: "ALL_ORDERS",
      raw_table: "amazon_all_orders",
      raw_table_exists: await tableExists(client, "amazon_all_orders"),
      domain_row_count: await countTable(client, "amazon_all_orders"),
      parser: "mapRowToAmazonAllOrders",
      manual_import: "file sync only",
      api_worker: "none",
      schedule_key: null,
      schedule_enabled: null,
      scheduled_executor: "none",
      credentials: "N/A",
      last_success_at: allOrdersUp.at,
      last_success_source: allOrdersUp.type,
      next_run_at: null,
      derived_rebuild: "product resolver Lane A; txn inheritance",
      health_card: "none",
      staging_original_parity: "file import only both envs",
      blocker: "no SP-API worker planned in automation_settings",
    },
    {
      api: "delayed-not-received",
      raw_table: "expected_packages + claim_cases (operational)",
      raw_table_exists: await tableExists(client, "expected_packages"),
      domain_row_count: await countTable(client, "expected_packages"),
      parser: "claim desk / scanner (not Amazon report)",
      manual_import: "none (operational workflow)",
      api_worker: "none",
      schedule_key: null,
      schedule_enabled: null,
      scheduled_executor: "none",
      credentials: "N/A",
      last_success_at: null,
      last_success_source: null,
      next_run_at: null,
      derived_rebuild: "depends on removal → expected_packages rebuild",
      health_card: "claim policy settings only",
      staging_original_parity: "N/A (workflow)",
      blocker: "not an import automation; depends on removal EP rebuild",
    },
  ];

  await client.end();
  return { label, apis, settings_snapshot: {
    removal_enabled: settings.removal_api_sync.enabled,
    product_enabled: settings.product_enrichment.enabled,
    reimb_enabled: settings.reimbursements_api.enabled,
    settlement_enabled: settings.settlement_api.enabled,
    finances_enabled: settings.finances_archive_api.enabled,
  }};
}

async function main() {
  loadEnvLocalIntoProcess();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!originalUrl?.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL required");
  if (!stagingUrl?.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL required");

  const id = runId();
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/api-automation-gap", id);
  fs.mkdirSync(outDir, { recursive: true });

  async function fetchSettings(url: string) {
    const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query(`SELECT automation_settings FROM public.platform_settings WHERE id=true`);
    await c.end();
    return r.rows[0]?.automation_settings;
  }

  const [origSettings, stagSettings] = await Promise.all([
    fetchSettings(originalUrl),
    fetchSettings(stagingUrl),
  ]);

  const [original, staging] = await Promise.all([
    auditDb("original", originalUrl, origSettings),
    auditDb("staging", stagingUrl, stagSettings),
  ]);

  const working = original.apis.filter((a) => a.blocker === "none (fully wired)" || a.blocker === "none").map((a) => a.api);
  const broken = original.apis.filter((a) => a.blocker.includes("schedule UI without cron")).map((a) => a.api);
  const missingWorkers = original.apis.filter((a) => a.api_worker === "none").map((a) => a.api);
  const missingSchedules = original.apis.filter((a) => !a.schedule_key).map((a) => a.api);
  const credentialGaps = [
    "ENABLE_AMAZON_REPORTS_API_WORKER (master)",
    "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS",
    "ENABLE_AMAZON_REPORTS_API_SETTLEMENT",
    "ENABLE_AMAZON_FINANCES_API_INGEST",
    "stores.marketplaces.credentials (per store — runtime env check not in audit)",
  ];
  const derivedGaps = original.apis
    .filter((a) => a.derived_rebuild.includes("none") || a.derived_rebuild.startsWith("depends"))
    .map((a) => `${a.api}: ${a.derived_rebuild}`);

  const summary = {
    phase_number: "4B",
    run_id: id,
    api_status_table: original.apis,
    staging_api_status_table: staging.apis,
    working_apis: working,
    broken_apis: broken,
    missing_workers: missingWorkers,
    missing_schedules: missingSchedules,
    credential_gaps: credentialGaps,
    derived_rebuild_gaps: derivedGaps,
    SAFE_TO_FIX_API_WORKERS: "yes",
    new_phase_4_percent: 55,
    next_fix_prompt:
      "PHASE-4C-SCHEDULED-EXECUTOR-WIRE — add cron/scheduler executors for reimbursements_api, settlement_api, finances_archive_api mirroring removal pattern; keep file-only governance for ledger/SAFET/ALL_ORDERS",
    settings_parity: { original: original.settings_snapshot, staging: staging.settings_snapshot },
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ outDir, working_apis: working.length, broken_apis: broken.length }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
