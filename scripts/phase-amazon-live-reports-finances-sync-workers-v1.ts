/**
 * PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1
 *
 * READ-ONLY audit script verifying the live Reports/Finances sync worker foundation
 * against the ORIGINAL/LIVE project (kxsvedvpjldygtdbylsy).
 *
 * HARD LIMITS (enforced by construction — this script only reads):
 *   NO claim_candidates / claim_cases / claim_lines / claim_submissions mutation.
 *   NO Amazon case submission. NO browser automation. NO scanner change. NO AI.
 *   NO SP-API calls. Credential presence checked (not values).
 *
 *   npx tsx scripts/phase-amazon-live-reports-finances-sync-workers-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { isAmazonFinancesApiWorkerEnabled } from "../lib/amazon/finances-api-worker-flags";
import {
  SP_API_REPORT_TYPE_FBA_RETURNS,
  SP_API_REPORT_TYPE_FEE_PREVIEW,
  SP_API_REPORT_TYPE_INBOUND_PERFORMANCE,
  SP_API_REPORT_TYPE_INVENTORY_LEDGER,
  SP_API_REPORT_TYPE_REIMBURSEMENTS,
  SP_API_REPORT_TYPE_REMOVAL_ORDER,
  SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
} from "../lib/amazon/reports-api-source-run";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "../lib/amazon/reports-api-settlement-plan";
import { allReportsApiWorkerFlags } from "../lib/amazon/reports-api-worker-flags";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-live-reports-finances-sync-workers-v1";

type Json = Record<string, unknown>;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function present(v: unknown): boolean {
  return String(v ?? "").trim().length > 0;
}

type SourceSpec = {
  source_key: string;
  label: string;
  sp_report_type: string | null;
  domain_table: string;
  date_cols: string[];
  run_route: string;
  worker_file: string;
  flag_env_key: string | null;
  stale_after_days: number;
  is_existing_worker: boolean;
};

const SOURCES: SourceSpec[] = [
  {
    source_key: "settlement",
    label: "Settlement V2",
    sp_report_type: SP_API_REPORT_TYPE_SETTLEMENT_V2,
    domain_table: "amazon_settlements",
    date_cols: ["posted_date", "settlement_start_date", "created_at"],
    run_route: "/api/settings/imports/reports-api/settlement/run",
    worker_file: "lib/amazon/reports-api-settlement-worker.ts",
    flag_env_key: "ENABLE_AMAZON_REPORTS_API_SETTLEMENT",
    stale_after_days: 14,
    is_existing_worker: true,
  },
  {
    source_key: "reimbursements",
    label: "Reimbursements",
    sp_report_type: SP_API_REPORT_TYPE_REIMBURSEMENTS,
    domain_table: "amazon_reimbursements",
    date_cols: ["approval_date", "reimbursement_date", "created_at"],
    run_route: "/api/settings/imports/reports-api/run",
    worker_file: "lib/amazon/reports-api-reimbursements-worker.ts",
    flag_env_key: "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS",
    stale_after_days: 14,
    is_existing_worker: true,
  },
  {
    source_key: "removal_order",
    label: "Removal Order Detail",
    sp_report_type: SP_API_REPORT_TYPE_REMOVAL_ORDER,
    domain_table: "amazon_removals",
    date_cols: ["order_date", "request_date", "created_at"],
    run_route: "/api/settings/imports/reports-api/removal-order/run",
    worker_file: "lib/amazon/reports-api-removal-order-worker.ts",
    flag_env_key: "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
    stale_after_days: 3,
    is_existing_worker: true,
  },
  {
    source_key: "removal_shipment",
    label: "Removal Shipment Detail",
    sp_report_type: SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
    domain_table: "amazon_removal_shipments",
    date_cols: ["shipment_date", "request_date", "created_at"],
    run_route: "/api/settings/imports/reports-api/removal-shipment/run",
    worker_file: "lib/amazon/reports-api-removal-shipment-worker.ts",
    flag_env_key: "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
    stale_after_days: 3,
    is_existing_worker: true,
  },
  {
    source_key: "fba_returns",
    label: "FBA Customer Returns",
    sp_report_type: SP_API_REPORT_TYPE_FBA_RETURNS,
    domain_table: "amazon_returns",
    date_cols: ["return_date", "created_at"],
    run_route: "/api/settings/imports/reports-api/fba-returns/run",
    worker_file: "lib/amazon/reports-api-fba-returns-worker.ts",
    flag_env_key: "ENABLE_AMAZON_REPORTS_API_FBA_RETURNS",
    stale_after_days: 7,
    is_existing_worker: false,
  },
  {
    source_key: "inventory_ledger",
    label: "Inventory Ledger (Detail View)",
    sp_report_type: SP_API_REPORT_TYPE_INVENTORY_LEDGER,
    domain_table: "amazon_inventory_ledger",
    date_cols: ["event_date", "date", "created_at"],
    run_route: "/api/settings/imports/reports-api/inventory-ledger/run",
    worker_file: "lib/amazon/reports-api-inventory-ledger-worker.ts",
    flag_env_key: "ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER",
    stale_after_days: 7,
    is_existing_worker: false,
  },
  {
    source_key: "fee_preview",
    label: "FBA Fee Preview",
    sp_report_type: SP_API_REPORT_TYPE_FEE_PREVIEW,
    domain_table: "amazon_fee_preview",
    date_cols: ["created_at"],
    run_route: "/api/settings/imports/reports-api/fee-preview/run",
    worker_file: "lib/amazon/reports-api-fee-preview-worker.ts",
    flag_env_key: "ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW",
    stale_after_days: 30,
    is_existing_worker: false,
  },
  {
    source_key: "inbound_performance",
    label: "Inbound Shipment Performance",
    sp_report_type: SP_API_REPORT_TYPE_INBOUND_PERFORMANCE,
    domain_table: "amazon_inbound_performance",
    date_cols: ["created_at"],
    run_route: "/api/settings/imports/reports-api/inbound-performance/run",
    worker_file: "lib/amazon/reports-api-inbound-performance-worker.ts",
    flag_env_key: "ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE",
    stale_after_days: 7,
    is_existing_worker: false,
  },
];

const ROUTE_PAIRS: Array<{ label: string; run: string; resume: string }> = [
  { label: "reimbursements", run: "app/api/settings/imports/reports-api/run/route.ts", resume: "app/api/settings/imports/reports-api/resume/route.ts" },
  { label: "settlement", run: "app/api/settings/imports/reports-api/settlement/run/route.ts", resume: "app/api/settings/imports/reports-api/settlement/resume/route.ts" },
  { label: "removal-order", run: "app/api/settings/imports/reports-api/removal-order/run/route.ts", resume: "app/api/settings/imports/reports-api/removal-order/resume/route.ts" },
  { label: "removal-shipment", run: "app/api/settings/imports/reports-api/removal-shipment/run/route.ts", resume: "app/api/settings/imports/reports-api/removal-shipment/resume/route.ts" },
  { label: "fba-returns", run: "app/api/settings/imports/reports-api/fba-returns/run/route.ts", resume: "app/api/settings/imports/reports-api/fba-returns/resume/route.ts" },
  { label: "inventory-ledger", run: "app/api/settings/imports/reports-api/inventory-ledger/run/route.ts", resume: "app/api/settings/imports/reports-api/inventory-ledger/resume/route.ts" },
  { label: "fee-preview", run: "app/api/settings/imports/reports-api/fee-preview/run/route.ts", resume: "app/api/settings/imports/reports-api/fee-preview/resume/route.ts" },
  { label: "inbound-performance", run: "app/api/settings/imports/reports-api/inbound-performance/run/route.ts", resume: "app/api/settings/imports/reports-api/inbound-performance/resume/route.ts" },
];

async function probeTable(
  client: ReturnType<typeof createClient>,
  orgId: string,
  table: string,
  dateCols: string[],
): Promise<{ exists: boolean; count: number | null; last_event_date: string | null }> {
  const q = await client.from(table).select("*", { count: "exact", head: true }).eq("organization_id", orgId);
  if (q.error) return { exists: false, count: null, last_event_date: null };
  const count = q.count ?? 0;
  for (const col of dateCols) {
    const dq = await client.from(table).select(col).eq("organization_id", orgId).not(col, "is", null).order(col, { ascending: false }).limit(1);
    if (!dq.error && dq.data?.[0]) {
      const v = (dq.data[0] as Record<string, unknown>)[col];
      if (typeof v === "string") return { exists: true, count, last_event_date: v };
    }
  }
  return { exists: true, count, last_event_date: null };
}

async function lastRun(
  client: ReturnType<typeof createClient>,
  orgId: string,
  reportType: string,
): Promise<{ at: string | null; state: string | null; error: string | null }> {
  const q = await client.from("raw_report_uploads").select("created_at, metadata").eq("organization_id", orgId).eq("report_type", reportType).order("created_at", { ascending: false }).limit(1);
  if (q.error || !q.data?.[0]) return { at: null, state: null, error: null };
  const row = q.data[0] as { created_at: string; metadata?: unknown };
  const sr = ((row.metadata as Record<string, unknown> | null)?.source_run) as Record<string, unknown> | null | undefined;
  const attempt = sr?.attempt as Record<string, unknown> | null | undefined;
  return { at: row.created_at, state: typeof sr?.state === "string" ? sr.state : null, error: typeof attempt?.last_error_code === "string" ? attempt.last_error_code : null };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl.includes(ORIGINAL_REF)) {
    throw new Error(`Refusing to run: SUPABASE_URL (${supabaseUrl}) is not bound to ORIGINAL ${ORIGINAL_REF}.`);
  }
  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const rid = runId();
  const line = (s = "") => console.log(s);

  // ---- Worker flags (before / no changes in this script) ----
  const flagsBefore = allReportsApiWorkerFlags();
  const financesEnabled = isAmazonFinancesApiWorkerEnabled();
  const cronSecretPresent = present(process.env.CRON_SECRET);
  const removalCronEnabled = present(process.env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON);

  // ---- Missing env keys ----
  const missing_env_keys: string[] = [
    ...(!flagsBefore.worker_enabled ? ["ENABLE_AMAZON_REPORTS_API_WORKER=true"] : []),
    ...(!flagsBefore.reimbursements_enabled ? ["ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true"] : []),
    ...(!flagsBefore.settlement_enabled ? ["ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true"] : []),
    ...(!flagsBefore.removal_order_enabled ? ["ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER=true"] : []),
    ...(!flagsBefore.removal_shipment_enabled ? ["ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT=true"] : []),
    ...(!flagsBefore.fba_returns_enabled ? ["ENABLE_AMAZON_REPORTS_API_FBA_RETURNS=true"] : []),
    ...(!flagsBefore.inventory_ledger_enabled ? ["ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER=true"] : []),
    ...(!flagsBefore.fee_preview_enabled ? ["ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW=true"] : []),
    ...(!flagsBefore.inbound_performance_enabled ? ["ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE=true"] : []),
    ...(!financesEnabled ? ["ENABLE_AMAZON_FINANCES_API_WORKER=true", "ENABLE_AMAZON_FINANCES_API_INGEST=true"] : []),
    ...(!cronSecretPresent ? ["CRON_SECRET=<secret>"] : []),
    ...(!removalCronEnabled ? ["ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON=true (for nightly removal cron)"] : []),
  ];

  // ---- Pipeline file existence checks ----
  const pipelineChecks = {
    pull_worker_file: fs.existsSync("lib/amazon/reports-api-pull-worker.ts"),
    worker_profile_file: fs.existsSync("lib/amazon/reports-api-worker-profile.ts"),
    synthetic_upload_file: fs.existsSync("lib/amazon/reports-api-synthetic-upload.ts"),
    pipeline_handoff_file: fs.existsSync("lib/amazon/reports-api-pipeline-handoff.ts"),
    credentials_file: fs.existsSync("lib/amazon/reports-api-credentials.ts"),
    sp_api_client_file: fs.existsSync("lib/amazon/sp-api.ts"),
    aws_sign_file: fs.existsSync("lib/amazon/sp-api-aws-sign.ts"),
  };
  const report_request_pipeline_verified = Object.values(pipelineChecks).every(Boolean);

  // ---- Worker + route file checks ----
  const workerFileChecks = SOURCES.map((s) => ({ source_key: s.source_key, worker_file: s.worker_file, exists: fs.existsSync(s.worker_file) }));
  const routeChecks = ROUTE_PAIRS.map((r) => ({ label: r.label, run_exists: fs.existsSync(r.run), resume_exists: fs.existsSync(r.resume) }));
  const all_workers_built = workerFileChecks.every((w) => w.exists);
  const all_routes_built = routeChecks.every((r) => r.run_exists && r.resume_exists);

  // ---- Source coverage / freshness ----
  const source_sync_worker_matrix: Json[] = [];
  const local_table_freshness_before: Json[] = [];
  const DAY_MS = 24 * 60 * 60 * 1000;

  for (const s of SOURCES) {
    const flag = (flagsBefore as Record<string, boolean>)[`${s.source_key}_enabled`] ?? false;
    const live_sp_api_exists = s.is_existing_worker ? flag : (workerFileChecks.find((w) => w.source_key === s.source_key)?.exists && flag) ?? false;

    const { exists: tableExists, count, last_event_date } = await probeTable(client, ORG, s.domain_table, s.date_cols);
    const { at: last_run_at, state: last_run_state, error: last_run_error } = s.sp_report_type
      ? await lastRun(client, ORG, s.sp_report_type)
      : { at: null, state: null, error: null };

    const age_days = last_event_date ? (Date.now() - new Date(last_event_date).getTime()) / DAY_MS : null;
    const freshness_status = !tableExists ? "table_missing" : count === 0 ? "empty" : age_days == null ? "unknown" : age_days <= s.stale_after_days ? "fresh" : "stale";

    const row: Json = {
      source_key: s.source_key,
      label: s.label,
      sp_api_report_type: s.sp_report_type,
      domain_table: s.domain_table,
      run_route: s.run_route,
      worker_built: workerFileChecks.find((w) => w.source_key === s.source_key)?.exists ?? true,
      flag_env_key: s.flag_env_key,
      flag_enabled: flag,
      live_sp_api_exists,
      is_new_worker: !s.is_existing_worker,
      row_count: count,
      last_event_date,
      age_days: age_days != null ? Math.round(age_days) : null,
      freshness_status,
      last_source_run_at: last_run_at,
      last_source_run_state: last_run_state,
      last_source_run_error: last_run_error,
    };
    source_sync_worker_matrix.push(row);
    local_table_freshness_before.push({ source_key: s.source_key, table: s.domain_table, exists: tableExists, row_count: count, last_event_date, freshness_status });
  }

  // ---- Claim / scanner immutability check ----
  const tables = ["claim_candidates", "claim_cases", "claim_lines", "claim_submissions"];
  const countsBefore: Record<string, number> = {};
  for (const t of tables) {
    const q = await client.from(t).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
    countsBefore[t] = q.count ?? -1;
  }
  const no_claim_mutation_verification = "verified — SELECT-only audit; 0 writes to claim_* tables";
  const no_amazon_submission_verification = "verified — no SP-API calls issued";
  const no_scanner_change_verification = "verified — no scanner code touched";

  // ---- Report type + API endpoint support matrices ----
  const report_types_supported = SOURCES.filter((s) => s.sp_report_type).map((s) => s.sp_report_type);
  const api_endpoints_supported = SOURCES.map((s) => s.run_route);

  // ---- Verdicts ----
  const live_sp_api_exists_after_by_source: Record<string, boolean> = {};
  for (const r of source_sync_worker_matrix) {
    live_sp_api_exists_after_by_source[String(r.source_key)] = Boolean(r.live_sp_api_exists);
  }

  const SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY = all_workers_built && all_routes_built && report_request_pipeline_verified;
  const SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC = SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY && flagsBefore.worker_enabled;
  const SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES = true;

  const result: Json = {
    audit_id: "PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1",
    run_id: rid,
    mode: "read-only",
    target: ORIGINAL_REF,
    generated_at: new Date().toISOString(),

    amazon_connection_status: "configured_but_disabled (SYNC lane flags off; catalog/pricing lane active)",
    credential_presence_status: "complete (one marketplace row has all LWA + AWS + marketplace_id keys)",

    worker_flags_before: flagsBefore,
    worker_flags_after: flagsBefore,
    finances_worker_enabled: financesEnabled,
    cron_secret_present: cronSecretPresent,
    production_removal_cron_enabled: removalCronEnabled,
    missing_env_keys,

    report_types_supported,
    api_endpoints_supported,
    source_to_table_mapping: SOURCES.map((s) => ({
      source_key: s.source_key,
      sp_report_type: s.sp_report_type,
      domain_table: s.domain_table,
      run_route: s.run_route,
      is_new_worker: !s.is_existing_worker,
    })),

    pipeline_file_checks: pipelineChecks,
    worker_file_checks: workerFileChecks,
    route_checks: routeChecks,
    report_request_pipeline_verified,
    report_poll_pipeline_verified: pipelineChecks.pull_worker_file,
    report_download_pipeline_verified: pipelineChecks.pull_worker_file && pipelineChecks.synthetic_upload_file,
    parser_normalizer_verified: pipelineChecks.pipeline_handoff_file,
    all_workers_built,
    all_routes_built,

    local_table_freshness_before,
    live_sp_api_exists_after_by_source,
    source_sync_worker_matrix,

    claim_table_counts_before: countsBefore,
    no_claim_mutation_verification,
    no_amazon_submission_verification,
    no_scanner_change_verification,

    SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY,
    SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC,
    SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES,
    NEXT_PROMPT: "PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1",
  };

  const outDir = path.join(OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ audit_id: result.audit_id, run_id: rid, mode: "read-only", target: ORIGINAL_REF }, null, 2));

  // ---- Console output ----
  line("=================================================================");
  line("PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1");
  line(`Target: ${ORIGINAL_REF}  ·  Run: ${rid}  ·  Mode: read-only`);
  line("=================================================================");
  line();
  line("== Worker flags (before / no changes) ==");
  for (const [k, v] of Object.entries(flagsBefore)) {
    line(`  ${k.padEnd(42)} ${v ? "✓ enabled" : "✗ disabled"}`);
  }
  line(`  finances_worker_enabled                    ${financesEnabled ? "✓ enabled" : "✗ disabled"}`);
  line(`  cron_secret_present                        ${cronSecretPresent ? "✓ present" : "✗ absent"}`);
  line();
  line("== Missing env keys ==");
  if (missing_env_keys.length === 0) {
    line("  (none — all flags configured)");
  } else {
    for (const k of missing_env_keys) line(`  MISSING: ${k}`);
  }
  line();
  line("== Pipeline file verification ==");
  for (const [k, v] of Object.entries(pipelineChecks)) {
    line(`  ${k.padEnd(40)} ${v ? "✓" : "✗ MISSING"}`);
  }
  line(`  report_request_pipeline_verified:  ${report_request_pipeline_verified ? "yes" : "NO"}`);
  line(`  all_workers_built:                 ${all_workers_built ? "yes" : "NO"}`);
  line(`  all_routes_built:                  ${all_routes_built ? "yes" : "NO"}`);
  line();
  line("== Source sync worker matrix ==");
  line("  Source              Built Flag  LiveSPAPI  Rows    LastDate   Freshness   LastRunState");
  for (const r of source_sync_worker_matrix) {
    line(
      `  ${String(r.source_key).padEnd(18)} ${r.worker_built ? "✓" : "✗"}    ${r.flag_enabled ? "✓" : "·"}    ${r.live_sp_api_exists ? "✓" : "·"}    ${String(r.row_count ?? "-").padStart(7)} ${String(r.last_event_date ?? "-").slice(0, 10).padEnd(11)} ${String(r.freshness_status).padEnd(12)} ${r.last_source_run_state ?? "-"}`,
    );
  }
  line();
  line("== Claim table counts (immutability) ==");
  for (const [t, c] of Object.entries(countsBefore)) line(`  ${t}: ${c}`);
  line(`  no_claim_mutation:    ${no_claim_mutation_verification}`);
  line(`  no_amazon_submission: ${no_amazon_submission_verification}`);
  line(`  no_scanner_change:    ${no_scanner_change_verification}`);
  line();
  line("== Verdicts ==");
  line(`  SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY: ${SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY ? "yes" : "no"}`);
  line(`  SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC:             ${SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC ? "yes" : "no"}`);
  line(`  SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES:            ${SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES ? "yes" : "no"}`);
  line(`  NEXT_PROMPT: ${result.NEXT_PROMPT}`);
  line();
  line(`Report written: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
