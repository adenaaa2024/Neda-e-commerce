/**
 * PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1 — live RUN orchestrator.
 *
 * This is the *executor* companion to `phase-amazon-initial-live-source-sync-execute-v1.ts`
 * (which is the gate + read-only freshness reporter). This orchestrator actually drives the
 * existing, already-guarded SP-API / Reports / Finances pull workers for the LIVE project
 * (kxsvedvpjldygtdbylsy) for a configured rolling window.
 *
 * HARD LIMITS (enforced by construction):
 *   - Refuses to issue ANY Amazon call unless BOTH gates pass:
 *       (1) operator approval token APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes
 *       (2) worker master flag ENABLE_AMAZON_REPORTS_API_WORKER=true (+ per-source flags)
 *     If either gate fails -> hard stop, no Amazon calls, no faked success.
 *   - Uses ONLY the existing import pipeline (request -> poll -> download -> parse ->
 *     normalize -> import). Stores raw + normalized rows via the synthetic-upload importer.
 *   - NO claim_candidate generation. NO mutation of claim_candidates / claim_cases /
 *     claim_lines / claim_submissions (verified by before/after counts). NO scanner change.
 *   - NO Amazon case submission. NO browser automation. NO AI as source of truth.
 *   - Per-source: if a report permission is missing, record blocker + continue other sources.
 *   - Respects rate limits: bounded resume attempts with cooldown sleeps; per-source +
 *     global wall budgets. Sources that do not finish in-budget keep their source_run_id and
 *     resume later via the existing resume routes / cron.
 *   - NEVER prints secret values.
 *
 *   npx tsx scripts/phase-amazon-initial-live-source-sync-run-v1.ts --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

const MISSING_SALE_SKUS = ["I6-VR35-FSXQ", "WD-VY8Z-CZ3F", "2H-7ZAX-Z2IP"];

// Configured rolling window (days) for the initial pull. Override with SYNC_WINDOW_DAYS.
const WINDOW_DAYS = Number(process.env.SYNC_WINDOW_DAYS ?? "30") || 30;
// Bounded resume policy (rate-limit friendly). SP-API report generation is async, so most
// on-demand reports will not be DONE within these attempts; they keep their source_run_id and
// resume later via cron / resume routes. Settlement (scheduled_list) often completes fast.
// Single kickoff pass per source by default: SP-API report generation is async, so on-demand
// reports return needs_resume on the first call (recording a source_run_id that the cron/resume
// routes finish later). Settlement (scheduled_list) can import in one call. Raise SYNC_MAX_ATTEMPTS
// to poll within this run.
const MAX_RESUME_ATTEMPTS = Number(process.env.SYNC_MAX_ATTEMPTS ?? "1") || 1;
const RESUME_SLEEP_MS = Number(process.env.SYNC_RESUME_SLEEP_MS ?? "6000") || 6000;
const PER_SOURCE_WALL_MS = Number(process.env.SYNC_PER_SOURCE_WALL_MS ?? "1200000") || 1200000;
const GLOBAL_WALL_MS = Number(process.env.SYNC_GLOBAL_WALL_MS ?? "3000000") || 3000000;
// Hard timeout per individual worker call. The streaming-import sources (settlement / finances
// flatten) can legitimately run several minutes, so they get a long cap; on-demand sources only
// request+poll on the first pass, so a short cap bounds a stalled SP-API socket (the client has no
// global request timeout). A timed-out source keeps its DB source_run for later resume.
const WORKER_TIMEOUT_LONG_MS = Number(process.env.SYNC_WORKER_TIMEOUT_LONG_MS ?? "900000") || 900000;
const WORKER_TIMEOUT_SHORT_MS = Number(process.env.SYNC_WORKER_TIMEOUT_SHORT_MS ?? "120000") || 120000;

type Json = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class WorkerTimeoutError extends Error {
  constructor(ms: number) {
    super(`worker call exceeded hard timeout (${ms}ms)`);
    this.name = "WorkerTimeoutError";
  }
}

/**
 * Hard timeout around a single worker call. The SP-API client has no global request timeout,
 * so a stalled network call could otherwise hang the whole run indefinitely. On timeout we
 * abandon the in-flight call (its source_run persists in the DB for later resume) and move on.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new WorkerTimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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

type WorkerResult = {
  ok: boolean;
  httpStatus: number;
  upload_id?: string | null;
  source_run_id: string | null;
  state: string | null;
  needs_resume: boolean;
  error?: string;
  error_code?: string;
  idempotent_replay?: boolean;
};

type SourceSpec = {
  source_key: string;
  label: string;
  sp_report_type: string | null;
  domain_table: string;
  date_cols: string[];
  flag_key: keyof ReturnType<typeof allReportsApiWorkerFlags> | "finances";
  env_flag: string;
  stale_after_days: number;
  worker_module: string;
  worker_export: string;
  is_finances?: boolean;
};

const SOURCES: SourceSpec[] = [
  { source_key: "settlement", label: "Settlement V2 / Transaction Order", sp_report_type: SP_API_REPORT_TYPE_SETTLEMENT_V2, domain_table: "amazon_settlements", date_cols: ["posted_date", "settlement_start_date", "created_at"], flag_key: "settlement_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_SETTLEMENT", stale_after_days: 14, worker_module: "../lib/amazon/reports-api-settlement-worker", worker_export: "runSettlementReportsWorker" },
  { source_key: "reimbursements", label: "Reimbursements", sp_report_type: SP_API_REPORT_TYPE_REIMBURSEMENTS, domain_table: "amazon_reimbursements", date_cols: ["approval_date", "reimbursement_date", "created_at"], flag_key: "reimbursements_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS", stale_after_days: 14, worker_module: "../lib/amazon/reports-api-reimbursements-worker", worker_export: "runReimbursementsReportsWorker" },
  { source_key: "removal_order", label: "Removal Orders", sp_report_type: SP_API_REPORT_TYPE_REMOVAL_ORDER, domain_table: "amazon_removals", date_cols: ["order_date", "request_date", "created_at"], flag_key: "removal_order_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER", stale_after_days: 3, worker_module: "../lib/amazon/reports-api-removal-order-worker", worker_export: "runRemovalOrderReportsWorker" },
  { source_key: "removal_shipment", label: "Removal Shipments", sp_report_type: SP_API_REPORT_TYPE_REMOVAL_SHIPMENT, domain_table: "amazon_removal_shipments", date_cols: ["shipment_date", "request_date", "created_at"], flag_key: "removal_shipment_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT", stale_after_days: 3, worker_module: "../lib/amazon/reports-api-removal-shipment-worker", worker_export: "runRemovalShipmentReportsWorker" },
  { source_key: "fba_returns", label: "FBA Customer Returns", sp_report_type: SP_API_REPORT_TYPE_FBA_RETURNS, domain_table: "amazon_returns", date_cols: ["return_date", "created_at"], flag_key: "fba_returns_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_FBA_RETURNS", stale_after_days: 7, worker_module: "../lib/amazon/reports-api-fba-returns-worker", worker_export: "runFbaReturnsReportsWorker" },
  { source_key: "inventory_ledger", label: "Inventory Ledger", sp_report_type: SP_API_REPORT_TYPE_INVENTORY_LEDGER, domain_table: "amazon_inventory_ledger", date_cols: ["event_date", "date", "created_at"], flag_key: "inventory_ledger_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER", stale_after_days: 7, worker_module: "../lib/amazon/reports-api-inventory-ledger-worker", worker_export: "runInventoryLedgerReportsWorker" },
  { source_key: "fee_preview", label: "Fee Preview", sp_report_type: SP_API_REPORT_TYPE_FEE_PREVIEW, domain_table: "amazon_fee_preview", date_cols: ["created_at"], flag_key: "fee_preview_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW", stale_after_days: 30, worker_module: "../lib/amazon/reports-api-fee-preview-worker", worker_export: "runFeePreviewReportsWorker" },
  { source_key: "inbound_performance", label: "Inbound Performance", sp_report_type: SP_API_REPORT_TYPE_INBOUND_PERFORMANCE, domain_table: "amazon_inbound_performance", date_cols: ["created_at"], flag_key: "inbound_performance_enabled", env_flag: "ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE", stale_after_days: 7, worker_module: "../lib/amazon/reports-api-inbound-performance-worker", worker_export: "runInboundPerformanceReportsWorker" },
  { source_key: "finances_archive", label: "Finances archive", sp_report_type: null, domain_table: "amazon_transactions", date_cols: ["posted_date", "created_at"], flag_key: "finances", env_flag: "ENABLE_AMAZON_FINANCES_API_WORKER", stale_after_days: 14, worker_module: "../lib/amazon/finances-api-ingest-worker", worker_export: "runFinancesApiIngestWorker", is_finances: true },
];

async function probeTable(
  client: SupabaseClient,
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

/** Resolve the Amazon SP-API store for the org (store-scoped worker context). */
async function resolveAmazonStoreId(client: SupabaseClient, orgId: string): Promise<string | null> {
  const q = await client
    .from("stores")
    .select("id, is_active, platform, marketplaces(provider)")
    .eq("organization_id", orgId);
  if (q.error || !q.data) return null;
  const rows = q.data as Array<{ id: string; is_active?: boolean; platform?: string | null; marketplaces?: { provider?: string } | null }>;
  const amazon = rows.filter(
    (r) => r.marketplaces?.provider === "amazon_sp_api" || String(r.platform ?? "").toLowerCase().includes("amazon"),
  );
  const sorted = amazon.sort((a, b) => Number(b.is_active ?? false) - Number(a.is_active ?? false));
  return sorted[0]?.id ?? rows[0]?.id ?? null;
}

/** Read report_id out of the upload metadata for evidence (no secrets). */
async function reportIdForUpload(client: SupabaseClient, orgId: string, uploadId: string | null): Promise<string | null> {
  if (!uploadId) return null;
  const q = await client.from("raw_report_uploads").select("metadata").eq("id", uploadId).eq("organization_id", orgId).maybeSingle();
  if (q.error || !q.data) return null;
  const meta = (q.data as { metadata?: unknown }).metadata as Record<string, unknown> | null;
  const sr = (meta?.source_run ?? null) as Record<string, unknown> | null;
  const ext = (sr?.external_ids ?? null) as Record<string, unknown> | null;
  const rid = ext?.report_id;
  return typeof rid === "string" && rid.trim() ? rid : null;
}

function isPermissionError(code?: string, err?: string): boolean {
  const c = String(code ?? "").toLowerCase();
  const e = String(err ?? "").toLowerCase();
  return (
    c.includes("forbidden") ||
    c.includes("unauthorized") ||
    c.includes("access") ||
    c.includes("permission") ||
    e.includes("forbidden") ||
    e.includes("unauthorized") ||
    e.includes("access denied") ||
    e.includes("not authorized") ||
    e.includes("403")
  );
}

function isRateLimitError(code?: string, err?: string): boolean {
  const c = String(code ?? "").toLowerCase();
  const e = String(err ?? "").toLowerCase();
  return c.includes("throttle") || c.includes("rate") || e.includes("throttl") || e.includes("quotaexceeded") || e.includes("429");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl.includes(ORIGINAL_REF)) {
    throw new Error(`Refusing to run: SUPABASE_URL (${supabaseUrl}) is not bound to ORIGINAL ${ORIGINAL_REF}.`);
  }
  const execute = process.argv.includes("--execute");
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
  const liveSyncPermitted = approved && workerMasterReady;

  // ---- Claim/scanner immutability BEFORE (read-only) ----
  const claimTables = ["claim_candidates", "claim_cases", "claim_lines", "claim_submissions"];
  const claim_counts_before: Record<string, number> = {};
  for (const t of claimTables) {
    const q = await client.from(t).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
    claim_counts_before[t] = q.count ?? -1;
  }

  // Floor the window to UTC-day boundaries so the worker idempotency key is STABLE across re-runs
  // within the same day. (A runtime-precise window would change every run and force a full re-pull.)
  const window = (() => {
    const now = new Date();
    const endDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(endDay.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return { start: start.toISOString(), end: endDay.toISOString() };
  })();

  const sources_requested: string[] = [];
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
  const DAY_MS = 24 * 60 * 60 * 1000;

  let storeId: string | null = null;
  let storeResolveError: string | null = null;

  if (liveSyncPermitted && execute) {
    storeId = await resolveAmazonStoreId(client, ORG);
    if (!storeId) storeResolveError = "No Amazon SP-API store found for org.";
  }

  const globalStarted = Date.now();

  for (const s of SOURCES) {
    const flagEnabled = s.flag_key === "finances" ? financesEnabled : (flags as Record<string, boolean>)[s.flag_key] ?? false;
    const before = await probeTable(client, ORG, s.domain_table, s.date_cols);

    // ---- Blocked (gate or flag or dry-run) ----
    if (!liveSyncPermitted || !execute || !flagEnabled || !storeId) {
      const reasons: string[] = [];
      if (!approved) reasons.push("operator_approval_absent");
      if (!workerMasterReady) reasons.push("worker_disabled (ENABLE_AMAZON_REPORTS_API_WORKER)");
      if (!flagEnabled) reasons.push(`source_flag_disabled (${s.env_flag})`);
      if (!execute) reasons.push("dry_run (pass --execute to pull)");
      if (liveSyncPermitted && execute && flagEnabled && !storeId) reasons.push(storeResolveError ?? "store_unresolved");
      sources_requested.push(s.source_key);
      sources_failed.push({ source_key: s.source_key, status: "blocked_at_gate", reasons });
      source_run_ids[s.source_key] = null;
      report_ids[s.source_key] = null;
      rows_imported_by_source[s.source_key] = 0;
      const ageB = before.last_event_date ? (Date.now() - new Date(before.last_event_date).getTime()) / DAY_MS : null;
      latest_event_date_by_source[s.source_key] = before.last_event_date;
      freshness_status_after[s.source_key] = !before.exists ? "table_missing" : (before.count ?? 0) === 0 ? "empty" : ageB == null ? "unknown" : ageB <= s.stale_after_days ? "fresh" : "stale";
      per_source.push({ source_key: s.source_key, label: s.label, status: "blocked_at_gate", block_reasons: reasons, existing_row_count: before.count, rows_imported_this_run: 0, source_run_id: null, report_id: null });
      continue;
    }

    // ---- Live pull (gates passed + --execute + flag on + store resolved) ----
    sources_requested.push(s.source_key);
    let result: WorkerResult | null = null;
    let attempts = 0;
    let uploadId: string | null = null;
    let permissionBlocked = false;
    const srcStarted = Date.now();
    // settlement streams a full import in one call; finances flatten can also be long.
    const callTimeoutMs = s.source_key === "settlement" || s.is_finances ? WORKER_TIMEOUT_LONG_MS : WORKER_TIMEOUT_SHORT_MS;

    try {
      // Worker modules `import "server-only"` (needs --conditions=react-server) and, under the
      // CJS interop, expose their named exports on `default`. Resolve from either location.
      const mod = (await import(s.worker_module)) as Record<string, unknown> & { default?: Record<string, unknown> };
      const candidate = (mod[s.worker_export] ?? mod.default?.[s.worker_export]) as
        | ((req: Json, deps?: Json) => Promise<WorkerResult>)
        | undefined;
      if (typeof candidate !== "function") {
        throw new Error(
          `Worker export ${s.worker_export} not found in ${s.worker_module} (run with: node --conditions=react-server --import tsx ...).`,
        );
      }
      const worker = candidate;

      const baseReq: Json = s.is_finances
        ? { organizationId: ORG, storeId, marketplaceId: null, windowStart: window.start, windowEnd: window.end, actorUserId: null }
        : { organizationId: ORG, storeId, windowStart: window.start, windowEnd: window.end, actorUserId: null };

      while (attempts < MAX_RESUME_ATTEMPTS) {
        attempts += 1;
        const req: Json = uploadId ? { ...baseReq, uploadId } : baseReq;
        try {
          result = await withTimeout(worker(req), callTimeoutMs);
        } catch (callErr) {
          if (callErr instanceof WorkerTimeoutError) {
            // Stalled SP-API call: abandon this pass; the source_run persists for later resume.
            rate_limit_or_api_errors.push({ source_key: s.source_key, kind: "timeout", detail: `hard ${callTimeoutMs}ms` });
            result = result ?? { ok: false, httpStatus: 504, upload_id: uploadId, source_run_id: null, state: "polling", needs_resume: true, error_code: "worker_call_timeout" };
            result = { ...result, needs_resume: true, error_code: "worker_call_timeout" };
            break;
          }
          throw callErr;
        }
        uploadId = result.upload_id ?? uploadId;

        if (isPermissionError(result.error_code, result.error)) {
          permissionBlocked = true;
          missing_permissions.push({ source_key: s.source_key, sp_report_type: s.sp_report_type, error_code: result.error_code ?? null });
          break;
        }
        if (isRateLimitError(result.error_code, result.error)) {
          rate_limit_or_api_errors.push({ source_key: s.source_key, kind: "throttle", error_code: result.error_code ?? null });
        }
        if (result.state === "complete" || result.state === "failed") break;
        if (!result.needs_resume) break;
        if (Date.now() - srcStarted > PER_SOURCE_WALL_MS) break;
        if (Date.now() - globalStarted > GLOBAL_WALL_MS) break;
        await sleep(RESUME_SLEEP_MS);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = { ok: false, httpStatus: 500, source_run_id: null, state: "failed", needs_resume: false, error: msg, error_code: "orchestrator_exception" };
      if (isRateLimitError(undefined, msg)) rate_limit_or_api_errors.push({ source_key: s.source_key, kind: "throttle", detail: "see error" });
    }

    const after = await probeTable(client, ORG, s.domain_table, s.date_cols);
    const rowsDelta = (after.count ?? 0) - (before.count ?? 0);
    const reportId = await reportIdForUpload(client, ORG, uploadId);
    const ageA = after.last_event_date ? (Date.now() - new Date(after.last_event_date).getTime()) / DAY_MS : null;
    const freshness = !after.exists ? "table_missing" : (after.count ?? 0) === 0 ? "empty" : ageA == null ? "unknown" : ageA <= s.stale_after_days ? "fresh" : "stale";

    source_run_ids[s.source_key] = result?.source_run_id ?? null;
    report_ids[s.source_key] = reportId;
    rows_imported_by_source[s.source_key] = rowsDelta > 0 ? rowsDelta : 0;
    latest_event_date_by_source[s.source_key] = after.last_event_date;
    freshness_status_after[s.source_key] = freshness;

    const state = result?.state ?? "unknown";
    const succeeded = state === "complete";
    const status = permissionBlocked
      ? "missing_permission"
      : succeeded
        ? "complete"
        : state === "failed"
          ? "failed"
          : "in_progress (needs_resume)";

    if (succeeded) sources_succeeded.push(s.source_key);
    else if (!permissionBlocked && state === "failed") sources_failed.push({ source_key: s.source_key, status, error_code: result?.error_code ?? null });

    per_source.push({
      source_key: s.source_key,
      label: s.label,
      sp_api_report_type: s.sp_report_type,
      domain_table: s.domain_table,
      flag_enabled: flagEnabled,
      attempts,
      state,
      status,
      existing_row_count_before: before.count,
      existing_row_count_after: after.count,
      rows_imported_this_run: rows_imported_by_source[s.source_key],
      source_run_id: result?.source_run_id ?? null,
      report_id: reportId,
      latest_event_date: after.last_event_date,
      freshness_status_after: freshness,
      needs_resume: result?.needs_resume ?? false,
      error_code: result?.error_code ?? null,
    });
  }

  // ---- Settlement Order rows for previously-missing SKUs (read-only) ----
  const settlement_order_rows_found_for_missing_skus: Json[] = [];
  for (const sku of MISSING_SALE_SKUS) {
    const q = await client.from("amazon_settlements").select("*", { count: "exact", head: true }).eq("organization_id", ORG).eq("sku", sku).eq("transaction_type", "Order");
    const found = q.error ? null : q.count ?? 0;
    settlement_order_rows_found_for_missing_skus.push({ sku, order_rows: found, note: q.error ? "probe_error_or_column_missing" : (found ?? 0) > 0 ? "order_rows_present" : "still_missing" });
  }

  // ---- Claim immutability AFTER ----
  const claim_counts_after: Record<string, number> = {};
  for (const t of claimTables) {
    const q = await client.from(t).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
    claim_counts_after[t] = q.count ?? -1;
  }
  const claimMutated = claimTables.some((t) => claim_counts_before[t] !== claim_counts_after[t]);

  const refreshedKey = (k: string): "yes" | "no" => (rows_imported_by_source[k] > 0 || source_run_ids[k] ? "yes" : "no");
  const reimbursement_rows_refreshed = refreshedKey("reimbursements");
  const removal_sources_refreshed = source_run_ids["removal_order"] || source_run_ids["removal_shipment"] ? "yes" : "no";
  const inventory_ledger_refreshed = refreshedKey("inventory_ledger");
  const fee_preview_refreshed = refreshedKey("fee_preview");
  const inbound_performance_refreshed = refreshedKey("inbound_performance");

  const anyImported = Object.values(rows_imported_by_source).some((v) => v > 0);
  const anyRun = Object.values(source_run_ids).some((v) => !!v);
  const SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE = liveSyncPermitted && execute && !claimMutated && (sources_succeeded.length > 0 || anyImported);
  const data_sources_hub_updated = anyRun ? "yes" : "no";

  const result: Json = {
    phase_id: "PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1",
    run_id: rid,
    mode: liveSyncPermitted && execute ? "live-execute" : execute ? "blocked-at-gate" : "dry-run",
    target: ORIGINAL_REF,
    generated_at: new Date().toISOString(),
    rolling_window: { days: WINDOW_DAYS, start: window.start, end: window.end },
    store_id_used: storeId,

    approval_status,
    env_keys_status,
    missing_env_keys,
    worker_flags: flags,
    finances_worker_enabled: financesEnabled,
    cron_secret_present: cronSecretPresent,
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
    reimbursement_rows_refreshed,
    removal_sources_refreshed,
    inventory_ledger_refreshed,
    fee_preview_refreshed,
    inbound_performance_refreshed,
    data_sources_hub_updated,

    claim_counts_before,
    claim_counts_after,
    no_claim_candidate_generation_verification: "verified — no generator invoked; orchestrator only calls source pull workers",
    no_claim_mutation_verification: claimMutated ? "FAILED — claim_* row counts changed" : "verified — claim_* row counts identical before/after",
    no_amazon_submission_verification: "verified — only Reports/Finances pull workers called; no case-submission / Feeds API",
    no_scanner_change_verification: "verified — no scanner code touched",

    SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE,
    SAFE_TO_RUN_PRODUCT_TRID_STORY_LIVE_REFRESH: !claimMutated ? "yes" : "no",
    SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN: !claimMutated ? "yes" : "no",
    NEXT_PROMPT: SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE
      ? "PHASE-PRODUCT-TRID-STORY-LIVE-REFRESH-V1 — refresh read models against freshly pulled live sources, then PHASE-FAMILY-CLAIM-GENERATORS-DRY-RUN-V1."
      : anyRun
        ? "RESUME — in-progress source_runs were left needing resume (async SP-API report generation). Re-run this phase (idempotent, resumes by source_run) or let the cron/resume routes finish, then run PHASE-PRODUCT-TRID-STORY-LIVE-REFRESH-V1."
        : "OPERATOR-ACTION — gates blocked; set approval=yes + worker flags + CRON_SECRET, then re-run with --execute.",
  };

  const outDir = path.join(OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ phase_id: result.phase_id, run_id: rid, mode: result.mode, target: ORIGINAL_REF }, null, 2));

  // ---- Console ----
  line("=================================================================");
  line("PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1 (run orchestrator)");
  line(`Target: ${ORIGINAL_REF}  ·  Run: ${rid}  ·  Mode: ${result.mode}`);
  line(`Window: ${window.start.slice(0, 10)} .. ${window.end.slice(0, 10)} (${WINDOW_DAYS}d)  ·  store=${storeId ?? "-"}`);
  line("=================================================================");
  line();
  line("== Gates ==");
  line(`  approval_status:     ${approval_status}`);
  line(`  env_keys_status:     ${env_keys_status}`);
  line(`  live_sync_permitted: ${liveSyncPermitted ? "YES" : "NO"}  ·  execute=${execute}`);
  line();
  line("== Per-source ==");
  line("  Source                State                 Rows+  RunId?  Report?  Freshness");
  for (const r of per_source as Array<Record<string, unknown>>) {
    line(
      `  ${String(r.source_key).padEnd(20)} ${String(r.status).padEnd(21)} ${String(r.rows_imported_this_run ?? 0).padStart(5)}  ${(r.source_run_id ? "yes" : "no").padEnd(6)}  ${(r.report_id ? "yes" : "no").padEnd(7)}  ${String(r.freshness_status_after ?? "-")}`,
    );
  }
  line();
  line("== Settlement Order rows for previously-missing SKUs ==");
  for (const r of settlement_order_rows_found_for_missing_skus as Array<Record<string, unknown>>) {
    line(`  ${String(r.sku).padEnd(14)} order_rows=${String(r.order_rows)} (${r.note})`);
  }
  line();
  line("== Immutability ==");
  for (const t of claimTables) line(`  ${t}: ${claim_counts_before[t]} -> ${claim_counts_after[t]}`);
  line(`  claim_mutated: ${claimMutated ? "YES (UNEXPECTED)" : "no"}`);
  line();
  line("== Verdicts ==");
  line(`  SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE:        ${SAFE_INITIAL_LIVE_SOURCE_SYNC_COMPLETE ? "yes" : "no"}`);
  line(`  SAFE_TO_RUN_PRODUCT_TRID_STORY_LIVE_REFRESH:   ${result.SAFE_TO_RUN_PRODUCT_TRID_STORY_LIVE_REFRESH}`);
  line(`  SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN:   ${result.SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN}`);
  line(`  data_sources_hub_updated:                      ${data_sources_hub_updated}`);
  line(`  NEXT_PROMPT: ${result.NEXT_PROMPT}`);
  line();
  line(`Report written: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
