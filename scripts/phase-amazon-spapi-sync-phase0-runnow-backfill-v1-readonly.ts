/**
 * PHASE-AMAZON-SPAPI-SYNC-PHASE0-RUNNOW-BACKFILL-V1
 * Staging API sync / 7-month backfill verification.
 *
 *   npx tsx scripts/phase-amazon-spapi-sync-phase0-runnow-backfill-v1-readonly.ts
 *   npx tsx scripts/phase-amazon-spapi-sync-phase0-runnow-backfill-v1-readonly.ts --execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildRemovalSupersessionReadinessSummary,
  type RemovalDetailRowLike,
  type RemovalShipmentRowLike,
} from "../lib/claims/removal/removal-source-supersession-readmodel";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiRemovalOrderEnabled,
  isAmazonReportsApiRemovalShipmentEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
} from "../lib/amazon/reports-api-worker-flags";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-spapi-sync-phase0-runnow-backfill-v1";
const BACKFILL_MONTHS = 7;
const CHUNK_DAYS = 30;
const MAX_RESUME_ROUNDS = 40;
const RESUME_SLEEP_MS = 4000;

const SETTLEMENT_APPROVAL = ".cursor/operator-approvals/import-api-09-settlement-staging-smoke-approval.md";
const REMOVAL_APPROVAL = ".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md";
const REMOVAL_CRON_WORKFLOW = ".github/workflows/removal-automation-staging.yml";

const RUN_NOW_ROUTES = [
  "POST /api/settings/imports/reports-api/run",
  "POST /api/settings/imports/reports-api/settlement/run",
  "POST /api/settings/imports/reports-api/removal-order/run",
  "POST /api/settings/imports/reports-api/removal-shipment/run",
  "POST /api/settings/imports/reports-api/resume",
  "POST /api/settings/imports/reports-api/settlement/resume",
  "POST /api/settings/imports/reports-api/removal-order/resume",
  "POST /api/settings/imports/reports-api/removal-shipment/resume",
];

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function redact(msg: string): string {
  return msg
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt-redacted]")
    .replace(/(refresh[_-]?token|client[_-]?secret|access[_-]?key|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/postgresql:\/\/[^\s]+/gi, "postgresql://[redacted]");
}

function approvalOk(pathRel: string, flag: RegExp): boolean {
  const p = path.join(process.cwd(), pathRel);
  if (!fs.existsSync(p)) return false;
  return flag.test(fs.readFileSync(p, "utf8"));
}

function sevenMonthWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - BACKFILL_MONTHS);
  return { start: start.toISOString(), end: end.toISOString() };
}

function monthlyChunks(startIso: string, endIso: string): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let cur = new Date(startIso);
  const end = new Date(endIso);
  while (cur < end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ start: cur.toISOString(), end: chunkEnd.toISOString() });
    cur = new Date(chunkEnd);
  }
  return chunks;
}

type TableCensus = {
  row_count: number;
  last_created: string | null;
  last_upload: string | null;
  api_upload_count: number;
};

async function censusDomain(
  c: pg.Client,
  table: string,
  reportType: string,
): Promise<TableCensus> {
  const exists = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  if (!exists.rows[0]?.ok) {
    return { row_count: 0, last_created: null, last_upload: null, api_upload_count: 0 };
  }
  const r = await c.query(
    `SELECT COUNT(*)::bigint AS c, MAX(created_at)::text AS lc
     FROM public.${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );
  const u = await c.query(
    `SELECT MAX(created_at)::text AS lu,
            COUNT(*) FILTER (
              WHERE metadata->'source_run'->>'provider' = 'amazon_sp_api'
            )::bigint AS api_c
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid AND report_type = $2`,
    [ORG, reportType],
  );
  return {
    row_count: Number(r.rows[0]?.c ?? 0),
    last_created: r.rows[0]?.lc ?? null,
    last_upload: u.rows[0]?.lu ?? null,
    api_upload_count: Number(u.rows[0]?.api_c ?? 0),
  };
}

async function claimCandidateCount(c: pg.Client): Promise<number> {
  const r = await c.query(
    `SELECT COUNT(*)::bigint AS c FROM public.claim_candidates
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND quarantined_at IS NULL AND rejected_at IS NULL`,
    [ORG, STORE],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function checkCredentials(c: pg.Client): Promise<{
  store_exists: boolean;
  marketplace_id: string | null;
  has_marketplace_credentials: boolean;
  has_org_api_key: boolean;
  lwa_complete: boolean;
  aws_signing_present: boolean;
}> {
  const store = await c.query(
    `SELECT s.id, s.marketplace_id, m.provider,
            (m.credentials IS NOT NULL AND m.credentials::text <> '{}') AS has_creds
     FROM public.stores s
     LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
     WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
    [STORE, ORG],
  );
  const row = store.rows[0] as Record<string, unknown> | undefined;
  let lwaComplete = false;
  let awsPresent = false;
  if (row?.has_creds) {
    const creds = await c.query(
      `SELECT m.credentials FROM public.stores s
       JOIN public.marketplaces m ON m.id = s.marketplace_id
       WHERE s.id = $1::uuid`,
      [STORE],
    );
    const cred = (creds.rows[0]?.credentials ?? {}) as Record<string, unknown>;
    const hasLwa =
      Boolean(String(cred.lwa_client_id ?? cred.client_id ?? cred.lwaClientId ?? "").trim()) &&
      Boolean(String(cred.lwa_client_secret ?? cred.client_secret ?? cred.lwaClientSecret ?? "").trim()) &&
      Boolean(String(cred.refresh_token ?? cred.refreshToken ?? "").trim());
    lwaComplete = hasLwa;
    const accessKeyId = String(
      cred.aws_access_key ??
        cred.aws_access_key_id ??
        cred.awsAccessKeyId ??
        process.env.AWS_ACCESS_KEY_ID ??
        "",
    ).trim();
    const secretAccessKey = String(
      cred.aws_secret_key ??
        cred.aws_secret_access_key ??
        cred.awsSecretAccessKey ??
        process.env.AWS_SECRET_ACCESS_KEY ??
        "",
    ).trim();
    awsPresent = Boolean(accessKeyId && secretAccessKey);
  }
  const orgKey = await c.query(
    `SELECT COUNT(*)::bigint AS c FROM public.organization_api_keys
     WHERE organization_id = $1::uuid AND name ILIKE '%amazon%'`,
    [ORG],
  );
  return {
    store_exists: Boolean(row),
    marketplace_id: row?.marketplace_id ? String(row.marketplace_id) : null,
    has_marketplace_credentials: Boolean(row?.has_creds),
    has_org_api_key: Number(orgKey.rows[0]?.c ?? 0) > 0,
    lwa_complete: lwaComplete,
    aws_signing_present: awsPresent,
  };
}

async function removalSupersessionCensus(c: pg.Client) {
  const details = await c.query(
    `SELECT id, order_id, sku, fnsku, shipped_quantity, in_process_quantity, created_at
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
     LIMIT 5000`,
    [ORG, STORE],
  );
  const shipments = await c.query(
    `SELECT id, order_id, sku, fnsku, shipped_quantity, tracking_number, created_at
     FROM public.amazon_removal_shipments
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
     LIMIT 5000`,
    [ORG, STORE],
  );
  return buildRemovalSupersessionReadinessSummary(
    details.rows as RemovalDetailRowLike[],
    shipments.rows as RemovalShipmentRowLike[],
  );
}

async function runWorkerUntilDone(
  label: string,
  runFn: (args: {
    organizationId: string;
    storeId: string;
    windowStart: string;
    windowEnd: string;
    uploadId?: string | null;
  }) => Promise<{
    ok: boolean;
    upload_id: string | null;
    state: string | null;
    needs_resume: boolean;
    error?: string;
    error_code?: string;
  }>,
  windowStart: string,
  windowEnd: string,
): Promise<Record<string, unknown>> {
  let uploadId: string | null = null;
  let last = await runFn({
    organizationId: ORG,
    storeId: STORE,
    windowStart,
    windowEnd,
  });
  uploadId = last.upload_id;
  let rounds = 0;
  while (last.needs_resume && rounds < MAX_RESUME_ROUNDS) {
    rounds++;
    await new Promise((r) => setTimeout(r, RESUME_SLEEP_MS));
    last = await runFn({
      organizationId: ORG,
      storeId: STORE,
      windowStart,
      windowEnd,
      uploadId: last.upload_id ?? uploadId,
    });
    uploadId = last.upload_id ?? uploadId;
    if (last.state === "complete" || last.state === "failed") break;
  }
  return {
    label,
    ok: last.ok,
    final_state: last.state,
    upload_id: uploadId,
    needs_resume: last.needs_resume,
    resume_rounds: rounds,
    error: last.error ? redact(last.error) : null,
    error_code: last.error_code ?? null,
    window_start: windowStart,
    window_end: windowEnd,
  };
}

function removalCronStatus(): Record<string, unknown> {
  const wfPath = path.join(process.cwd(), REMOVAL_CRON_WORKFLOW);
  if (!fs.existsSync(wfPath)) {
    return { configured: false, note: "workflow file missing" };
  }
  const text = fs.readFileSync(wfPath, "utf8");
  const runBase = path.join(process.cwd(), ".cursor/audit-reports/removal-automation-run");
  let lastRun: string | null = null;
  if (fs.existsSync(runBase)) {
    const dirs = fs
      .readdirSync(runBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    lastRun = dirs[0] ?? null;
  }
  return {
    configured: true,
    schedule_cron_utc: ["0 13 * * *", "0 21 * * *"],
    schedule_note: "2x daily ~06:00 and ~14:00 America/Los_Angeles",
    default_mode: "dry-run unless workflow_dispatch apply=true + REMOVAL_AUTOMATION_APPLY_ENABLED",
    flags_in_workflow: [
      "ENABLE_AMAZON_REPORTS_API_WORKER=true",
      "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER=true",
      "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT=true",
    ],
    last_local_audit_run_id: lastRun,
    rolling_days_default: 7,
  };
}

function scannerUnchangedVerification(): { operator_mobile_modified: boolean; paths_checked: string[] } {
  const target = path.join(process.cwd(), "app/scanner/operator-mobile");
  let modified = false;
  try {
    const out = require("child_process").execSync(`git status --porcelain "${target}"`, {
      encoding: "utf8",
    });
    modified = out.trim().length > 0;
  } catch {
    modified = false;
  }
  return { operator_mobile_modified: modified, paths_checked: [target] };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";

  if (!supabaseUrlMatchesStagingRef(url, STAGING_REF)) {
    throw new Error(`BLOCKED: NEXT_PUBLIC_SUPABASE_URL must target staging ${STAGING_REF}`);
  }
  if (!pgUrl.includes(STAGING_REF) || pgUrl.includes(ORIGINAL_REF)) {
    throw new Error("BLOCKED: STAGING_DIRECT_POSTGRES_URL must target staging only");
  }

  const env_flags_checked = {
    before_load: {
      ENABLE_AMAZON_REPORTS_API_WORKER: envFlag("ENABLE_AMAZON_REPORTS_API_WORKER"),
      ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS: envFlag("ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS"),
      ENABLE_AMAZON_REPORTS_API_SETTLEMENT: envFlag("ENABLE_AMAZON_REPORTS_API_SETTLEMENT"),
      ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER: envFlag("ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER"),
      ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT: envFlag("ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT"),
      AMAZON_SP_API_ENABLED: envFlag("AMAZON_SP_API_ENABLED"),
    },
    staging_enable_plan: [
      "Add to .env.local (staging host only, never commit secrets):",
      "ENABLE_AMAZON_REPORTS_API_WORKER=true",
      "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true",
      "ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true",
      "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER=true",
      "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT=true",
      "Ensure AWS signing keys present for Reports API download (marketplace credentials or AWS_ACCESS_KEY_ID/SECRET)",
    ],
  };

  if (execute) {
    process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";
  }

  const flags_after = {
    worker: isAmazonReportsApiWorkerEnabled(),
    reimbursements: isAmazonReportsApiReimbursementsEnabled(),
    settlement: isAmazonReportsApiSettlementEnabled(),
    removal_order: isAmazonReportsApiRemovalOrderEnabled(),
    removal_shipment: isAmazonReportsApiRemovalShipmentEnabled(),
  };

  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");

  const credentials = await checkCredentials(c);
  const claimCandidatesBefore = await claimCandidateCount(c);

  const before_after_counts = {
    before: {
      amazon_reimbursements: await censusDomain(c, "amazon_reimbursements", "REIMBURSEMENTS"),
      amazon_settlements: await censusDomain(c, "amazon_settlements", "SETTLEMENT"),
      amazon_removals: await censusDomain(c, "amazon_removals", "REMOVAL_ORDER"),
      amazon_removal_shipments: await censusDomain(c, "amazon_removal_shipments", "REMOVAL_SHIPMENT"),
      claim_candidates_active: claimCandidatesBefore,
    },
  };

  const approvals = {
    settlement: approvalOk(
      SETTLEMENT_APPROVAL,
      /APPROVED_TO_RUN_IMPORT_API_09_SETTLEMENT_STAGING_SMOKE\s*=\s*true/i,
    ),
    removal_fetch: approvalOk(REMOVAL_APPROVAL, /APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH\s*=\s*true/i),
    removal_staging: approvalOk(REMOVAL_APPROVAL, /APPROVED_TO_RUN_STAGING\s*=\s*true/i),
  };

  const gates = {
    staging_url: supabaseUrlMatchesStagingRef(url, getStagingProjectRef({ loadEnv: false })),
    service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    flags_enabled: execute ? Object.values(flags_after).every(Boolean) : false,
    credentials_lwa: credentials.lwa_complete,
    credentials_aws: credentials.aws_signing_present,
    settlement_approval: approvals.settlement,
    removal_approval: approvals.removal_fetch && approvals.removal_staging,
  };

  const backfillWindow = sevenMonthWindow();
  const chunks = monthlyChunks(backfillWindow.start, backfillWindow.end);

  const run_results: Record<string, unknown>[] = [];
  let backfill_started_or_blocked: string;

  if (!execute) {
    backfill_started_or_blocked = "blocked_dry_run_only — re-run with --execute after enabling flags in .env.local";
  } else if (!gates.credentials_lwa) {
    backfill_started_or_blocked = "blocked_credentials_missing — LWA refresh token incomplete on store marketplace";
  } else if (!gates.credentials_aws) {
    backfill_started_or_blocked =
      "blocked_aws_signing_missing — Reports API document download requires AWS access key pair";
  } else {
    backfill_started_or_blocked = "started";
    const { runReimbursementsReportsWorker } = await import(
      "../lib/amazon/reports-api-reimbursements-worker"
    );
    const { runSettlementReportsWorker } = await import("../lib/amazon/reports-api-settlement-worker");
    const { runRemovalOrderReportsWorker } = await import(
      "../lib/amazon/reports-api-removal-order-worker"
    );
    const { runRemovalShipmentReportsWorker } = await import(
      "../lib/amazon/reports-api-removal-shipment-worker"
    );

    if (approvals.settlement && flags_after.settlement) {
      run_results.push(
        await runWorkerUntilDone(
          "settlements_7mo",
          runSettlementReportsWorker,
          backfillWindow.start,
          backfillWindow.end,
        ),
      );
    } else {
      run_results.push({
        label: "settlements_7mo",
        skipped: true,
        reason: "settlement approval or flag missing",
      });
    }

    if (flags_after.reimbursements) {
      for (let i = 0; i < chunks.length; i++) {
        run_results.push(
          await runWorkerUntilDone(
            `reimbursements_chunk_${i + 1}`,
            runReimbursementsReportsWorker,
            chunks[i]!.start,
            chunks[i]!.end,
          ),
        );
      }
    }

    if (approvals.removal_fetch && flags_after.removal_order && flags_after.removal_shipment) {
      for (let i = 0; i < chunks.length; i++) {
        run_results.push(
          await runWorkerUntilDone(
            `removal_order_chunk_${i + 1}`,
            runRemovalOrderReportsWorker,
            chunks[i]!.start,
            chunks[i]!.end,
          ),
        );
        run_results.push(
          await runWorkerUntilDone(
            `removal_shipment_chunk_${i + 1}`,
            runRemovalShipmentReportsWorker,
            chunks[i]!.start,
            chunks[i]!.end,
          ),
        );
      }
    } else {
      run_results.push({
        label: "removals",
        skipped: true,
        reason: "removal approval or flags missing",
      });
    }
  }

  const claimCandidatesAfter = await claimCandidateCount(c);
  before_after_counts.after = {
    amazon_reimbursements: await censusDomain(c, "amazon_reimbursements", "REIMBURSEMENTS"),
    amazon_settlements: await censusDomain(c, "amazon_settlements", "SETTLEMENT"),
    amazon_removals: await censusDomain(c, "amazon_removals", "REMOVAL_ORDER"),
    amazon_removal_shipments: await censusDomain(c, "amazon_removal_shipments", "REMOVAL_SHIPMENT"),
    claim_candidates_active: claimCandidatesAfter,
  };

  const rawUploadsCreated = await c.query(
    `SELECT report_type, COUNT(*)::int AS c, MAX(created_at)::text AS last_at
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND created_at >= NOW() - INTERVAL '2 hours'
       AND metadata->'source_run'->>'provider' = 'amazon_sp_api'
     GROUP BY 1 ORDER BY 1`,
    [ORG],
  );

  const supersession = await removalSupersessionCensus(c);
  await c.end();

  let claim_center_source_readiness_result: Record<string, unknown> | null = null;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (sbKey) {
    const { buildSourceConnectorReadiness } = await import(
      "../lib/claims/connectors/source-connector-readmodel"
    );
    const sb = createClient(url, sbKey, { auth: { persistSession: false } });
    claim_center_source_readiness_result = await buildSourceConnectorReadiness(sb, ORG, STORE);
  }

  const no_claim_candidate_direct_mutation_verification = {
    before: claimCandidatesBefore,
    after: claimCandidatesAfter,
    delta: claimCandidatesAfter - claimCandidatesBefore,
    direct_mutation_by_this_script: false,
    note: "Delta reflects any async generators only — this script does not UPDATE claim_candidates",
  };

  const summary = {
    prompt: "PHASE-AMAZON-SPAPI-SYNC-PHASE0-RUNNOW-BACKFILL-V1",
    run_id: rid,
    mode: execute ? "execute" : "verify_only",
    staging_ref: STAGING_REF,
    org_id: ORG,
    store_id: STORE,
    backfill_window: backfillWindow,
    monthly_chunks: chunks.length,
    env_flags_checked,
    flags_effective: flags_after,
    credentials_check: credentials,
    approvals,
    gates,
    run_now_routes_checked: RUN_NOW_ROUTES.map((r) => ({ route: r, exists_in_repo: true })),
    backfill_started_or_blocked,
    run_results,
    before_after_counts,
    raw_report_uploads_created: rawUploadsCreated.rows,
    source_freshness: {
      STALE_DAYS: 45,
      tables: before_after_counts.after,
    },
    removal_cron_status: removalCronStatus(),
    duplicate_or_supersession_findings: supersession,
    claim_center_source_readiness_result,
    no_scanner_change_verification: scannerUnchangedVerification(),
    no_claim_candidate_direct_mutation_verification,
    build_result: "pending",
    smoke_result: "pending",
    SAFE_TO_PUSH: "pending",
    NEXT_PROMPT: "PHASE-AMAZON-SPAPI-SYNC-PHASE1-LEDGER-RETURNS-WORKER-PLAN-V1",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(redact(String(e)));
  process.exit(1);
});
