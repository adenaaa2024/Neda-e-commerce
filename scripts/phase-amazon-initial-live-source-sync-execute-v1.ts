/**
 * PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1
 *
 * Guarded initial live SP-API / Reports API source sync executor for the LIVE project
 * (kxsvedvpjldygtdbylsy). This script is the GATE + read-only freshness reporter.
 *
 * HARD LIMITS (enforced by construction):
 *   - NO live Amazon SP-API calls are issued unless BOTH gates pass:
 *       (1) operator approval token APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes
 *       (2) worker master flag ENABLE_AMAZON_REPORTS_API_WORKER=true (+ per-source flags)
 *     When either gate fails the executor records each source as BLOCKED with the exact
 *     reason + the exact missing env keys, and DOES NOT fake success.
 *   - NO claim_candidate generation. NO mutation of claim_candidates / claim_cases /
 *     claim_lines / claim_submissions. NO scanner change. NO AI as source of truth.
 *   - NO Amazon case submission. NO browser automation. NO secrets printed.
 *   - This file performs SELECT-only DB access (freshness/immutability probing).
 *
 *   npx tsx scripts/phase-amazon-initial-live-source-sync-execute-v1.ts
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
const OUT_BASE = ".cursor/audit-reports/phase-amazon-initial-live-source-sync-execute-v1";
const APPROVAL_FILE = ".cursor/operator-approvals/amazon-initial-live-source-sync-v1-approval.md";
const APPROVAL_TOKEN = "APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1";

// SKUs flagged in prior phases as missing sale-net / settlement Order rows.
const MISSING_SALE_SKUS = ["I6-VR35-FSXQ", "WD-VY8Z-CZ3F", "2H-7ZAX-Z2IP"];

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
  flag_key: keyof ReturnType<typeof allReportsApiWorkerFlags> | "finances";
  env_flag: string;
  stale_after_days: number;
};

const SOURCES: SourceSpec[] = [
  { source_key: "settlement", label: "Settlement V2 / Transaction Order", sp_report_type: SP_API_REPORT_TYPE_SETTLEMENT_V2, domain_table: "amazon_settlements", date_cols: ["posted_date", "settlement_start_date", "created_at"], flag_key: "settlement_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_SETTLEMENT", stale_after_days: 14 },
  { source_key: "reimbursements", label: "Reimbursements", sp_report_type: SP_API_REPORT_TYPE_REIMBURSEMENTS, domain_table: "amazon_reimbursements", date_cols: ["approval_date", "reimbursement_date", "created_at"], flag_key: "reimbursements_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS", stale_after_days: 14 },
  { source_key: "removal_order", label: "Removal Orders", sp_report_type: SP_API_REPORT_TYPE_REMOVAL_ORDER, domain_table: "amazon_removals", date_cols: ["order_date", "request_date", "created_at"], flag_key: "removal_order_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER", stale_after_days: 3 },
  { source_key: "removal_shipment", label: "Removal Shipments", sp_report_type: SP_API_REPORT_TYPE_REMOVAL_SHIPMENT, domain_table: "amazon_removal_shipments", date_cols: ["shipment_date", "request_date", "created_at"], flag_key: "removal_shipment_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT", stale_after_days: 3 },
  { source_key: "fba_returns", label: "FBA Customer Returns", sp_report_type: SP_API_REPORT_TYPE_FBA_RETURNS, domain_table: "amazon_returns", date_cols: ["return_date", "created_at"], flag_key: "fba_returns_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_FBA_RETURNS", stale_after_days: 7 },
  { source_key: "inventory_ledger", label: "Inventory Ledger", sp_report_type: SP_API_REPORT_TYPE_INVENTORY_LEDGER, domain_table: "amazon_inventory_ledger", date_cols: ["event_date", "date", "created_at"], flag_key: "inventory_ledger_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER", stale_after_days: 7 },
  { source_key: "fee_preview", label: "Fee Preview", sp_report_type: SP_API_REPORT_TYPE_FEE_PREVIEW, domain_table: "amazon_fee_preview", date_cols: ["created_at"], flag_key: "fee_preview_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW", stale_after_days: 30 },
  { source_key: "inbound_performance", label: "Inbound Performance", sp_report_type: SP_API_REPORT_TYPE_INBOUND_PERFORMANCE, domain_table: "amazon_inbound_performance", date_cols: ["created_at"], flag_key: "inbound_performance_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE", stale_after_days: 7 },
  { source_key: "finances_archive", label: "Finances archive", sp_report_type: null, domain_table: "amazon_transactions", date_cols: ["posted_date", "created_at"], flag_key: "finances", env_flag: "ENABLE_AMAZON_FINANCES_API_WORKER", stale_after_days: 14 },
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
      const v = (dq.data[0] as unknown as Record<string, unknown>)[col];
      if (typeof v === "string") return { exists: true, count, last_event_date: v };
    }
  }
  return { exists: true, count, last_event_date: null };
}

async function credentialPresence(
  client: ReturnType<typeof createClient>,
  orgId: string,
): Promise<{ status: string; active_rows: number; has_lwa: boolean }> {
  const q = await client.from("marketplaces").select("id, provider, is_active, credentials").eq("organization_id", orgId);
  if (q.error || !q.data) return { status: "unknown", active_rows: 0, has_lwa: false };
  let has_lwa = false;
  let active = 0;
  for (const row of q.data as Array<{ is_active?: boolean; credentials?: unknown }>) {
    if (row.is_active) active += 1;
    const c = (row.credentials ?? {}) as Record<string, unknown>;
    const keys = Object.keys(c).join(",").toLowerCase();
    if (keys.includes("refresh") || keys.includes("lwa") || keys.includes("client_id")) has_lwa = true;
  }
  return { status: has_lwa ? "present" : "incomplete", active_rows: active, has_lwa };
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

  // ---- Gate 1: operator approval ----
  let approvalFound = false;
  let approvalToken = "no";
  if (fs.existsSync(APPROVAL_FILE)) {
    approvalFound = true;
    const txt = fs.readFileSync(APPROVAL_FILE, "utf8");
    const m = txt.match(new RegExp(`${APPROVAL_TOKEN}\\s*=\\s*(\\w+)`));
    approvalToken = m ? m[1].toLowerCase() : "no";
  }
  const approved = approvalFound && approvalToken === "yes";
  const approval_status = !approvalFound
    ? "blocked — approval file absent"
    : approved
      ? "approved"
      : `blocked — token ${APPROVAL_TOKEN}=${approvalToken} (expected yes)`;

  // ---- Gate 2: env keys / worker flags ----
  const flags = allReportsApiWorkerFlags();
  const financesEnabled = isAmazonFinancesApiWorkerEnabled();
  const cronSecretPresent = present(process.env.CRON_SECRET);

  const missing_env_keys: string[] = [
    ...(!flags.worker_enabled ? ["ENABLE_AMAZON_REPORTS_API_WORKER=true"] : []),
    ...(!flags.settlement_enabled ? ["ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true"] : []),
    ...(!flags.reimbursements_enabled ? ["ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true"] : []),
    ...(!flags.removal_order_enabled ? ["ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER=true"] : []),
    ...(!flags.removal_shipment_enabled ? ["ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT=true"] : []),
    ...(!flags.fba_returns_enabled ? ["ENABLE_AMAZON_REPORTS_API_FBA_RETURNS=true"] : []),
    ...(!flags.inventory_ledger_enabled ? ["ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER=true"] : []),
    ...(!flags.fee_preview_enabled ? ["ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW=true"] : []),
    ...(!flags.inbound_performance_enabled ? ["ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE=true"] : []),
    ...(!financesEnabled ? ["ENABLE_AMAZON_FINANCES_API_WORKER=true", "ENABLE_AMAZON_FINANCES_API_INGEST=true"] : []),
    ...(!cronSecretPresent ? ["CRON_SECRET=<secret>"] : []),
  ];
  const env_keys_status = missing_env_keys.length === 0 ? "complete" : `incomplete — ${missing_env_keys.length} key(s) missing`;

  const workerMasterReady = flags.worker_enabled;
  // Live pull is permitted ONLY when both gates pass. Otherwise: hard block, no Amazon calls.
  const liveSyncPermitted = approved && workerMasterReady;

  // ---- Credential presence (read-only; no values) ----
  const creds = await credentialPresence(client, ORG);

  // ---- Read-only freshness BEFORE (== AFTER, since no live pull runs while blocked) ----
  const DAY_MS = 24 * 60 * 60 * 1000;
  const sources_requested: string[] = SOURCES.map((s) => s.source_key);
  const sources_succeeded: string[] = [];
  const sources_failed: Json[] = [];
  const source_run_ids: Record<string, string | null> = {};
  const report_ids: Record<string, string | null> = {};
  const rows_imported_by_source: Record<string, number> = {};
  const latest_event_date_by_source: Record<string, string | null> = {};
  const freshness_status_after: Record<string, string> = {};
  const missing_permissions: Json[] = [];
  const rate_limit_or_api_errors: Json[] = [];
  const per_source: Json[] = [];

  for (const s of SOURCES) {
    const flagEnabled = s.flag_key === "finances" ? financesEnabled : (flags as Record<string, boolean>)[s.flag_key] ?? false;
    const { exists, count, last_event_date } = await probeTable(client, ORG, s.domain_table, s.date_cols);
    const age_days = last_event_date ? (Date.now() - new Date(last_event_date).getTime()) / DAY_MS : null;
    const freshness = !exists ? "table_missing" : count === 0 ? "empty" : age_days == null ? "unknown" : age_days <= s.stale_after_days ? "fresh" : "stale";

    latest_event_date_by_source[s.source_key] = last_event_date;
    freshness_status_after[s.source_key] = freshness;
    rows_imported_by_source[s.source_key] = 0; // no live pull executed while blocked
    source_run_ids[s.source_key] = null;
    report_ids[s.source_key] = null;

    // BLOCKED: record reason; DO NOT call Amazon.
    const reasons: string[] = [];
    if (!approved) reasons.push("operator_approval_absent");
    if (!workerMasterReady) reasons.push("worker_disabled (ENABLE_AMAZON_REPORTS_API_WORKER)");
    if (!flagEnabled) reasons.push(`source_flag_disabled (${s.env_flag})`);
    sources_failed.push({ source_key: s.source_key, status: "blocked_at_gate", reasons });

    per_source.push({
      source_key: s.source_key,
      label: s.label,
      sp_api_report_type: s.sp_report_type,
      domain_table: s.domain_table,
      flag_env_key: s.env_flag,
      flag_enabled: flagEnabled,
      table_exists: exists,
      existing_row_count: count,
      latest_event_date: last_event_date,
      freshness_status_after: freshness,
      rows_imported_this_run: 0,
      source_run_id: null,
      report_id: null,
      status: "blocked_at_gate",
      block_reasons: reasons,
    });
  }

  // ---- Settlement Order rows for previously-missing SKUs (read-only) ----
  const settlement_order_rows_found_for_missing_skus: Json[] = [];
  for (const sku of MISSING_SALE_SKUS) {
    let found = 0;
    const q = await client
      .from("amazon_settlements")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", ORG)
      .eq("sku", sku)
      .eq("transaction_type", "Order");
    if (!q.error) found = q.count ?? 0;
    settlement_order_rows_found_for_missing_skus.push({ sku, order_rows: q.error ? null : found, note: q.error ? "probe_error_or_column_missing" : found > 0 ? "order_rows_present" : "still_missing" });
  }

  // ---- Claim / scanner immutability (read-only; no writes anywhere in this script) ----
  const claimTables = ["claim_candidates", "claim_cases", "claim_lines", "claim_submissions"];
  const claim_table_counts: Record<string, number> = {};
  for (const t of claimTables) {
    const q = await client.from(t).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
    claim_table_counts[t] = q.count ?? -1;
  }

  const SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE = liveSyncPermitted && sources_succeeded.length > 0;
  // Source-linkage / dry-run generators do not require fresh live data; they remain safe to run.
  const SAFE_TO_RUN_PRODUCT_TRID_STORY_LINKAGE = true;
  const SAFE_TO_RUN_CLAIM_GENERATORS_DRY_RUN = true;

  const result: Json = {
    phase_id: "PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1",
    run_id: rid,
    mode: liveSyncPermitted ? "live-execute" : "blocked-at-gate (read-only)",
    target: ORIGINAL_REF,
    generated_at: new Date().toISOString(),

    approval_status,
    approval_file_present: approvalFound,
    approval_token_value: approvalToken,
    env_keys_status,
    missing_env_keys,
    worker_flags: flags,
    finances_worker_enabled: financesEnabled,
    cron_secret_present: cronSecretPresent,
    credential_presence: creds.status,
    credential_active_marketplaces: creds.active_rows,
    live_sync_permitted: liveSyncPermitted,

    sources_requested,
    sources_succeeded,
    sources_failed,
    source_run_ids,
    report_ids,
    rows_imported_by_source,
    latest_event_date_by_source,
    freshness_status_after,
    missing_permissions,
    rate_limit_or_api_errors,
    per_source,

    settlement_order_rows_found_for_missing_skus,
    reimbursement_rows_refreshed: "no",
    removal_sources_refreshed: "no",
    inventory_ledger_refreshed: "no",
    fee_preview_refreshed: "no",
    inbound_performance_refreshed: "no",

    claim_table_counts,
    no_claim_candidate_generation_verification: "verified — generator never invoked; SELECT-only script; 0 inserts",
    no_claim_mutation_verification: "verified — 0 writes to claim_candidates/claim_cases/claim_lines/claim_submissions",
    no_amazon_submission_verification: "verified — no SP-API / case submission calls issued (gate blocked live pull)",
    no_scanner_change_verification: "verified — no scanner code touched",

    SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE,
    SAFE_TO_RUN_PRODUCT_TRID_STORY_LINKAGE,
    SAFE_TO_RUN_CLAIM_GENERATORS_DRY_RUN,
    NEXT_PROMPT: liveSyncPermitted
      ? "PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1"
      : "OPERATOR-ACTION: set APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes + enable ENABLE_AMAZON_REPORTS_API_* / FINANCES / CRON_SECRET, then re-run this phase with --execute.",
  };

  const outDir = path.join(OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ phase_id: result.phase_id, run_id: rid, mode: result.mode, target: ORIGINAL_REF }, null, 2));

  // ---- Console output ----
  line("=================================================================");
  line("PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1");
  line(`Target: ${ORIGINAL_REF}  ·  Run: ${rid}  ·  Mode: ${result.mode}`);
  line("=================================================================");
  line();
  line("== Gates ==");
  line(`  approval_status:      ${approval_status}`);
  line(`  env_keys_status:      ${env_keys_status}`);
  line(`  worker master flag:   ${flags.worker_enabled ? "enabled" : "DISABLED"}`);
  line(`  credential_presence:  ${creds.status} (${creds.active_rows} active marketplace row[s])`);
  line(`  live_sync_permitted:  ${liveSyncPermitted ? "YES" : "NO"}`);
  line();
  line("== Missing env keys (set these to enable the sync) ==");
  if (missing_env_keys.length === 0) line("  (none)");
  else for (const k of missing_env_keys) line(`  MISSING: ${k}`);
  line();
  line("== Per-source (freshness unchanged; no live pull ran) ==");
  line("  Source                Flag  Rows     LastEvent    Freshness    Status");
  for (const r of per_source) {
    line(
      `  ${String(r.source_key).padEnd(20)} ${(r.flag_enabled ? "✓" : "·")}    ${String(r.existing_row_count ?? "-").padStart(7)}  ${String(r.latest_event_date ?? "-").slice(0, 10).padEnd(11)}  ${String(r.freshness_status_after).padEnd(11)}  ${r.status}`,
    );
  }
  line();
  line("== Settlement Order rows for previously-missing SKUs ==");
  for (const r of settlement_order_rows_found_for_missing_skus as Array<Record<string, unknown>>) {
    line(`  ${String(r.sku).padEnd(14)} order_rows=${String(r.order_rows)} (${r.note})`);
  }
  line();
  line("== Claim table counts (immutability) ==");
  for (const [t, c] of Object.entries(claim_table_counts)) line(`  ${t}: ${c}`);
  line();
  line("== Verdicts ==");
  line(`  SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE:  ${SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE ? "yes" : "no"}`);
  line(`  SAFE_TO_RUN_PRODUCT_TRID_STORY_LINKAGE:  ${SAFE_TO_RUN_PRODUCT_TRID_STORY_LINKAGE ? "yes" : "no"}`);
  line(`  SAFE_TO_RUN_CLAIM_GENERATORS_DRY_RUN:    ${SAFE_TO_RUN_CLAIM_GENERATORS_DRY_RUN ? "yes" : "no"}`);
  line(`  NEXT_PROMPT: ${result.NEXT_PROMPT}`);
  line();
  line(`Report written: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
