/**
 * PHASE1-API-SYNC-90DAY-BURNIN-STAGING
 * Supervised 90-day removal/shipment sync — dry-run, apply, idempotency.
 *
 *   npx tsx scripts/phase1-api-sync-90day-burnin-staging.ts
 *   npx tsx scripts/phase1-api-sync-90day-burnin-staging.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

import {
  queryEpAllocationMismatchBreakdown,
  rebuildValidFromBreakdown,
} from "../lib/removal/ep-allocation-mismatch-breakdown";
import { readPlatformAutomationSettingsFromPg } from "../lib/platform-automation-settings-read";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const ROLLING_DAYS = 90;
const OUT_BASE = ".cursor/audit-reports/phase1-api-sync-90day-burnin-staging";

const APPROVALS = [
  ".cursor/operator-approvals/removal-automation-cron-implementation-approval.md",
  ".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md",
  ".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md",
  ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md",
] as const;

type Snapshot = {
  removals: number;
  shipments: number;
  derived_ep: number;
  return_items: number;
  dup_business_key: number;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(f: string): boolean {
  return process.argv.includes(f);
}

function readApprovalsReady(): boolean {
  return APPROVALS.every((p) => {
    const text = fs.existsSync(path.join(process.cwd(), p)) ? fs.readFileSync(path.join(process.cwd(), p), "utf8") : "";
    return /APPROVED.*=\s*true/i.test(text);
  });
}

function endOfYesterdayUtc(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function computeWindow(): { start: string; end: string; rolling_days: number } {
  const end = endOfYesterdayUtc();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - ROLLING_DAYS);
  start.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString(), rolling_days: ROLLING_DAYS };
}

function fetchApiEnv(): Record<string, string> {
  return {
    ENABLE_AMAZON_REPORTS_API_WORKER: "true",
    ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER: "true",
    ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT: "true",
    ENABLE_IMPORT_DESCRIPTOR_METADATA: "true",
    REMOVAL_AUTOMATION_TARGET_REF: STAGING_REF,
  };
}

async function snapshot(client: pg.Client): Promise<Snapshot> {
  const r = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid) AS removals,
       (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS shipments,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS derived_ep,
       (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS return_items,
       (SELECT COUNT(*)::int FROM (
          SELECT source_detail_row_id, source_shipment_row_id, build_source, allocation_group_key
          FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')
          GROUP BY 1,2,3,4 HAVING count(*)>1
        ) x) AS dup_business_key`,
    [ORG_ID],
  );
  const row = r.rows[0] as Record<string, number>;
  return {
    removals: Number(row.removals),
    shipments: Number(row.shipments),
    derived_ep: Number(row.derived_ep),
    return_items: Number(row.return_items),
    dup_business_key: Number(row.dup_business_key),
  };
}

function runOrchestrator(runId: string, apply: boolean): { ok: boolean } {
  const argv = [
    "tsx",
    "scripts/removal-automation-orchestrator.ts",
    `--run-id=${runId}`,
    `--rolling-days=${ROLLING_DAYS}`,
    "--manual",
  ];
  if (apply) argv.push("--apply");
  const res = spawnSync("npx", argv, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...fetchApiEnv(),
      ...(apply ? { REMOVAL_AUTOMATION_CONFIRM_APPLY: "true" } : {}),
    },
    shell: true,
    encoding: "utf8",
    stdio: "inherit",
  });
  return { ok: res.status === 0 };
}

function readFetchSummary(runId: string): {
  synthetic_uploads: number;
  order_byte_length: number;
  shipment_byte_length: number;
  window: { start?: string; end?: string } | null;
} {
  const base = path.join(
    process.cwd(),
    ".cursor/audit-reports/sp-api-removal-reports-fetch-execute",
    `${runId}-fetch`,
  );
  const manifestPath = path.join(base, "manifest.json");
  const summaryPath = path.join(base, "synthetic-upload-summary.json");
  let synthetic_uploads = 0;
  let window: { start?: string; end?: string } | null = null;
  let order_byte_length = 0;
  let shipment_byte_length = 0;
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    synthetic_uploads = Number(m.synthetic_uploads_count ?? 2);
    window = (m.window as { start?: string; end?: string }) ?? null;
  }
  if (fs.existsSync(summaryPath)) {
    const s = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
      uploads?: { label?: string; byte_length?: number }[];
    };
    for (const u of s.uploads ?? []) {
      if (u.label === "removal_order") order_byte_length = Number(u.byte_length ?? 0);
      if (u.label === "removal_shipment") shipment_byte_length = Number(u.byte_length ?? 0);
    }
  }
  return { synthetic_uploads, order_byte_length, shipment_byte_length, window };
}

function readResolverUpdates(runId: string): number {
  const p = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-post-sync-resolver-reconcile",
    `${runId}-resolver`,
    "manifest.json",
  );
  if (!fs.existsSync(p)) return 0;
  const m = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  return Number(m.applied_update_count ?? 0);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const applyRequested = hasFlag("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];
  if (refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") !== STAGING_REF) {
    blockers.push("staging ref mismatch");
  }
  if (refFromSupabaseUrl(process.env.ORIGINAL_DIRECT_POSTGRES_URL ?? "") === ORIGINAL_REF) {
    blockers.push("original ref forbidden");
  }
  if (process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim() === "true") {
    blockers.push("REMOVAL_AUTOMATION_APPLY_ENABLED must stay off");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");

  const window = computeWindow();
  let before: Snapshot | null = null;
  let mismatchBefore = null as Awaited<ReturnType<typeof queryEpAllocationMismatchBreakdown>> | null;
  let historicalOff = true;

  if (dbUrl && !blockers.length) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const settings = await readPlatformAutomationSettingsFromPg(client);
    historicalOff = !settings.removal_api_sync.historical_backfill.enabled;
    before = await snapshot(client);
    mismatchBefore = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
    await client.end();
  }

  let dryRunOk = false;
  if (!blockers.length) {
    dryRunOk = runOrchestrator(`${runId}-dryrun`, false).ok;
    if (!dryRunOk) blockers.push("dry-run failed");
  }

  let after: Snapshot | null = null;
  let mismatchAfter = mismatchBefore;
  let idempotencyOk: boolean | null = null;
  let fetchSummary: ReturnType<typeof readFetchSummary> | null = null;
  let resolverUpdates = 0;

  const canApply =
    applyRequested &&
    dryRunOk &&
    readApprovalsReady() &&
    process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim() === "true" &&
    historicalOff &&
    !blockers.length;

  if (canApply) {
    const applyOk = runOrchestrator(`${runId}-apply`, true).ok;
    if (!applyOk) blockers.push("apply failed");

    fetchSummary = readFetchSummary(`${runId}-apply`);
    resolverUpdates = readResolverApplied(`${runId}-apply`);

    if (dbUrl) {
      const c2 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await c2.connect();
      after = await snapshot(c2);
      mismatchAfter = await queryEpAllocationMismatchBreakdown(c2, ORG_ID, STORE_ID);
      await c2.end();
    }

    const idemOk = runOrchestrator(`${runId}-idem`, true).ok;
    let afterIdem: Snapshot | null = null;
    if (dbUrl) {
      const c3 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await c3.connect();
      afterIdem = await snapshot(c3);
      await c3.end();
    }
    idempotencyOk =
      idemOk &&
      after != null &&
      afterIdem != null &&
      afterIdem.removals === after.removals &&
      afterIdem.shipments === after.shipments &&
      afterIdem.derived_ep === after.derived_ep &&
      afterIdem.return_items === before!.return_items;
  } else if (applyRequested) {
    blockers.push("apply skipped — dry-run/approvals/confirm/historical gate");
  }

  const finalSnap = after ?? before;
  const mismatch = mismatchAfter ?? mismatchBefore;
  const dupOk = (finalSnap?.dup_business_key ?? 1) === 0;
  const nonOverflowOk = (mismatch?.non_overflow ?? 1) === 0;
  const returnItemsOk = before && finalSnap ? finalSnap.return_items === before.return_items : true;

  const output = {
    WINDOW: fetchSummary?.window ?? window,
    ROWS_FETCHED: fetchSummary
      ? {
          synthetic_uploads: fetchSummary.synthetic_uploads,
          order_report_bytes: fetchSummary.order_byte_length,
          shipment_report_bytes: fetchSummary.shipment_byte_length,
        }
      : { note: "dry-run only — no SP-API fetch" },
    ROWS_APPLIED: before && after
      ? {
          removals_delta: after.removals - before.removals,
          shipments_delta: after.shipments - before.shipments,
        }
      : null,
    EXPECTED_PACKAGES_BEFORE_AFTER: before && finalSnap
      ? { before: before.derived_ep, after: finalSnap.derived_ep, delta: finalSnap.derived_ep - before.derived_ep }
      : null,
    RESOLVER_UPDATES: resolverUpdates,
    MISMATCH_COUNTS: mismatch
      ? {
          total: mismatch.total,
          overflow: mismatch.overflow,
          non_overflow: mismatch.non_overflow,
        }
      : null,
    MISMATCH_NON_OVERFLOW_COUNT: mismatch?.non_overflow ?? null,
    DUPLICATE_BUSINESS_KEYS: finalSnap?.dup_business_key ?? null,
    RETURN_ITEMS_UNCHANGED: before && finalSnap
      ? { before: before.return_items, after: finalSnap.return_items, unchanged: returnItemsOk }
      : null,
    dry_run_ok: dryRunOk,
    idempotency_ok: idempotencyOk,
    historical_backfill_off: historicalOff,
    safe_to_continue:
      !blockers.length &&
      dryRunOk &&
      dupOk &&
      nonOverflowOk &&
      returnItemsOk &&
      rebuildValidFromBreakdown(mismatch ?? { total: 1, overflow: 0, non_overflow: 1 }) &&
      (idempotencyOk === null || idempotencyOk === true),
    blockers,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"), ...output }, null, 2));
  if (!output.safe_to_continue && applyRequested) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
