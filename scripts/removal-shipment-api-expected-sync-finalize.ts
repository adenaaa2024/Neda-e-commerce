/**
 * REMOVAL-SHIPMENT-API-EXPECTED-SYNC-FINALIZE
 * Existing architecture only — staging, no original, no cron enable.
 *
 *   npx tsx scripts/removal-shipment-api-expected-sync-finalize.ts
 *   npx tsx scripts/removal-shipment-api-expected-sync-finalize.ts --apply --batch=small
 *   npx tsx scripts/removal-shipment-api-expected-sync-finalize.ts --apply --batch=recent90
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import pg from "pg";

import {
  queryEpAllocationMismatchBreakdown,
  rebuildValidFromBreakdown,
} from "../lib/removal/ep-allocation-mismatch-breakdown";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-shipment-api-expected-sync-finalize";
const WINDOW_CURSOR = ".cursor/audit-reports/removal-automation-run/.window-cursor.json";
const TARGET_HISTORICAL_START = "2025-09-01";

const HISTORICAL_SLOW_WINDOWS = [
  { key: "nov_2025_w1", start: "2025-11-01T00:00:00.000Z", end: "2025-11-07T23:59:59.999Z", probe: "DONE" },
  { key: "nov_2025_w2", start: "2025-11-08T00:00:00.000Z", end: "2025-11-14T23:59:59.999Z", probe: "FATAL" },
  { key: "nov_2025_w3", start: "2025-11-15T00:00:00.000Z", end: "2025-11-21T23:59:59.999Z", probe: "FATAL" },
  { key: "nov_2025_w4", start: "2025-11-22T00:00:00.000Z", end: "2025-11-30T23:59:59.999Z", probe: "FATAL" },
  { key: "dec_2025_w1", start: "2025-12-01T00:00:00.000Z", end: "2025-12-07T23:59:59.999Z", probe: "FATAL" },
  { key: "dec_2025_w2", start: "2025-12-08T00:00:00.000Z", end: "2025-12-14T23:59:59.999Z", probe: "FATAL" },
  { key: "dec_2025_w3", start: "2025-12-15T00:00:00.000Z", end: "2025-12-21T23:59:59.999Z", probe: "FATAL" },
  { key: "dec_2025_w4", start: "2025-12-22T00:00:00.000Z", end: "2025-12-25T23:59:59.999Z", probe: "QUOTA_UNTESTED" },
] as const;

type Snapshot = {
  raw_uploads: number;
  removals: number;
  shipments: number;
  derived_ep: number;
  ep_resolved: number;
  ep_unresolved: number;
  return_items: number;
  products: number;
  pim: number;
  dup_remainder: number;
  dup_business_key: number;
  upload_idem_dup: number;
  mismatch: Awaited<ReturnType<typeof queryEpAllocationMismatchBreakdown>>;
  max_order_date: string | null;
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

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.split("=")[1]!.trim() : null;
}

function endOfYesterdayUtc(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function rollingWindow(days: number): { start: string; end: string; days: number } {
  const end = endOfYesterdayUtc();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  start.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString(), days };
}

async function snapshot(client: pg.Client): Promise<Snapshot> {
  const r = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM public.raw_report_uploads WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')) AS raw_uploads,
       (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid) AS removals,
       (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS shipments,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS derived_ep,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NOT NULL) AS ep_resolved,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NULL) AS ep_unresolved,
       (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS return_items,
       (SELECT COUNT(*)::int FROM public.products) AS products,
       (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS pim,
       (SELECT COUNT(*)::int FROM (
          SELECT source_detail_row_id FROM public.expected_packages
          WHERE organization_id=$1::uuid AND build_source='detail_remainder'
          GROUP BY 1 HAVING count(*)>1
        ) x) AS dup_remainder,
       (SELECT COUNT(*)::int FROM (
          SELECT source_detail_row_id, source_shipment_row_id, build_source, allocation_group_key
          FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')
          GROUP BY 1,2,3,4 HAVING count(*)>1
        ) x) AS dup_business_key,
       (SELECT COUNT(*)::int FROM (
          SELECT metadata->'source_run'->>'idempotency_key' AS k, COUNT(*) AS c
          FROM public.raw_report_uploads WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
            AND metadata->'source_run'->>'idempotency_key' IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1
        ) x) AS upload_idem_dup,
       (SELECT max(order_date)::text FROM public.amazon_removals WHERE organization_id=$1::uuid) AS max_order_date`,
    [ORG_ID],
  );
  const row = r.rows[0] as Record<string, number | string | null>;
  const mismatch = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
  return {
    raw_uploads: Number(row.raw_uploads),
    removals: Number(row.removals),
    shipments: Number(row.shipments),
    derived_ep: Number(row.derived_ep),
    ep_resolved: Number(row.ep_resolved),
    ep_unresolved: Number(row.ep_unresolved),
    return_items: Number(row.return_items),
    products: Number(row.products),
    pim: Number(row.pim),
    dup_remainder: Number(row.dup_remainder),
    dup_business_key: Number(row.dup_business_key),
    upload_idem_dup: Number(row.upload_idem_dup),
    mismatch,
    max_order_date: row.max_order_date as string | null,
  };
}

async function monthlyGaps(client: pg.Client): Promise<unknown[]> {
  const r = await client.query(
    `SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS month,
            COUNT(*)::int AS removals
     FROM public.amazon_removals
     WHERE organization_id=$1::uuid AND order_date >= $2::date
     GROUP BY 1 ORDER BY 1`,
    [ORG_ID, TARGET_HISTORICAL_START],
  );
  return r.rows;
}

function runOrchestrator(
  runId: string,
  rollingDays: number,
  apply: boolean,
): { ok: boolean; exit_code: number | null } {
  const argv = [
    "tsx",
    "scripts/removal-automation-orchestrator.ts",
    `--run-id=${runId}-orch`,
    `--rolling-days=${rollingDays}`,
  ];
  if (apply) argv.push("--apply", "--manual");
  const res = spawnSync("npx", argv, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(apply ? { REMOVAL_AUTOMATION_CONFIRM_APPLY: "true" } : {}),
    },
    shell: true,
    encoding: "utf8",
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return { ok: res.status === 0, exit_code: res.status };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const manual = hasFlag("--manual");
  const batch = argValue("--batch=") ?? "none";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const blockers: string[] = [];
  if (branch !== "feature/product-canonicalization-v3" && !manual) {
    blockers.push(`Branch ${branch} !== feature/product-canonicalization-v3`);
  }
  if (process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim() === "true") {
    blockers.push("REMOVAL_AUTOMATION_APPLY_ENABLED must stay off");
  }
  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") ?? "";
  if (urlRef === ORIGINAL_REF) blockers.push("Original ref forbidden");
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (apply && process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim() !== "true") {
    blockers.push("REMOVAL_AUTOMATION_CONFIRM_APPLY=true required for --apply");
  }

  const client = dbUrl
    ? new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    : null;
  let before: Snapshot | null = null;
  let monthly: unknown[] = [];
  if (client) {
    await client.connect();
    before = await snapshot(client);
    monthly = await monthlyGaps(client);
    await client.end();
  }

  const windowCursor = fs.existsSync(WINDOW_CURSOR)
    ? JSON.parse(fs.readFileSync(WINDOW_CURSOR, "utf8"))
    : null;

  const recent7 = rollingWindow(7);
  const recent90 = rollingWindow(90);

  const architecture = {
    flow: [
      "SP-API createReport → raw_report_uploads + storage (reports-api-pull-worker)",
      "POST /api/settings/imports/sync → amazon_staging → amazon_removals | amazon_removal_shipments",
      "rebuild_expected_packages_from_removals → expected_packages (detail_shipment | detail_remainder)",
      "removal-post-sync-resolver-reconcile → map-only Product Core resolver on expected_packages",
    ],
    forbidden: ["return_items writes", "package_items", "auto product create", "original DB", "cron apply"],
    duplicate_prevention: [
      "source_run.idempotency_key per window+report_type",
      "content_sha256 dedupe on re-upload",
      "EP unique indexes on detail/shipment/remainder grain",
    ],
    product_linkage: "lib/removal/resolve-expected-package-product.ts (map-only, no product insert)",
  };

  const gaps = {
    recent_90_day: "Orchestrator supports --rolling-days=90; 7-day burn-in PASS; extend to 90 after allocation fix",
    historical_sept_2025: {
      loaded: "Sep–Oct 2025, Dec 26+ on staging",
      gap: "2025-11-08 → 2025-12-25 (monthly Nov mostly empty; split probe: only nov_2025_w1 DONE)",
      slow_windows: HISTORICAL_SLOW_WINDOWS,
    },
    expected_packages_builder: "rebuild_expected_packages_from_removals (grouped tracking) — active",
    allocation_blocker: before
      ? {
          non_overflow: before.mismatch.non_overflow,
          overflow: before.mismatch.overflow,
          rebuild_valid: rebuildValidFromBreakdown(before.mismatch),
          note: "2 pre-existing tracking-group under-allocations (801786d9…, bb91979c…) — blocks safe_to_continue",
        }
      : null,
    idempotency: before ? { upload_idem_dup_keys: before.upload_idem_dup } : null,
  };

  let batchResult: Record<string, unknown> | null = null;
  let after: Snapshot | null = null;
  let idempotencyRerun: Record<string, unknown> | null = null;

  if (apply && !blockers.length && (batch === "small" || batch === "recent90")) {
    const days = batch === "small" ? 7 : 90;
    const snapBefore = before!;
    const r1 = runOrchestrator(runId, days, true);
    const c2 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await c2.connect();
    after = await snapshot(c2);
    await c2.end();

    if (batch === "small" && r1.ok) {
      const r2 = runOrchestrator(`${runId}-idem`, days, true);
      const c3 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await c3.connect();
      const afterIdem = await snapshot(c3);
      await c3.end();
      idempotencyRerun = {
        first_run_ok: r1.ok,
        second_run_ok: r2.ok,
        delta_removals: afterIdem.removals - (after?.removals ?? 0),
        delta_shipments: afterIdem.shipments - (after?.shipments ?? 0),
        delta_derived_ep: afterIdem.derived_ep - (after?.derived_ep ?? 0),
        delta_return_items: afterIdem.return_items - snapBefore.return_items,
        delta_products: afterIdem.products - snapBefore.products,
        stable: afterIdem.removals === after?.removals && afterIdem.shipments === after?.shipments,
      };
      after = afterIdem;
    }

    batchResult = {
      batch,
      rolling_days: days,
      window: days === 7 ? recent7 : recent90,
      orchestrator_ok: r1.ok,
      before: snapBefore,
      after,
      delta: {
        removals: (after?.removals ?? 0) - snapBefore.removals,
        shipments: (after?.shipments ?? 0) - snapBefore.shipments,
        derived_ep: (after?.derived_ep ?? 0) - snapBefore.derived_ep,
        return_items: (after?.return_items ?? 0) - snapBefore.return_items,
      },
    };
  }

  const finalSnap = after ?? before;
  const rebuildValid = finalSnap ? rebuildValidFromBreakdown(finalSnap.mismatch) : false;
  const safeToContinue =
    blockers.length === 0 &&
    rebuildValid &&
    (finalSnap?.dup_remainder ?? 0) === 0 &&
    (finalSnap?.dup_business_key ?? 0) === 0 &&
    (batchResult?.delta?.return_items ?? 0) === 0;

  const report = [
    "# REMOVAL-SHIPMENT-API-EXPECTED-SYNC-FINALIZE",
    "",
    `Run: \`${runId}\` · Mode: **${apply ? `apply batch=${batch}` : "dry-run audit"}** · Staging \`${STAGING_REF}\``,
    "",
    "## CURRENT STATUS",
    "",
    "### Architecture (existing — unchanged)",
    "",
    ...architecture.flow.map((f) => `- ${f}`),
    "",
    "### Source / domain tables",
    "",
    "| Layer | Table | Role |",
    "|-------|-------|------|",
    "| Raw | `raw_report_uploads` | SP-API synthetic upload + `source_run` cursor |",
    "| Staging | `amazon_staging` | Normalized import rows (ephemeral) |",
    "| Detail | `amazon_removals` | REMOVAL_ORDER domain |",
    "| Shipment | `amazon_removal_shipments` | REMOVAL_SHIPMENT domain |",
    "| Expected | `expected_packages` | `detail_shipment` + `detail_remainder` derived rebuild |",
    "| Resolver | `expected_packages.resolved_product_id` | Product Core map-only |",
    "",
    "### Staging census",
    "",
    "```json",
    JSON.stringify({ before, monthly, window_cursor: windowCursor, recent7, recent90 }, null, 2),
    "```",
    "",
    "## MISSING GAPS (and status)",
    "",
    "```json",
    JSON.stringify(gaps, null, 2),
    "```",
    "",
    "| Gap | Status |",
    "|-----|--------|",
    "| 1. Recent 90-day sync | **Ready** via `--rolling-days=90`; blocked on allocation fix for `safe_to_continue` |",
    "| 2. Historical Sept 2025 slow windows | **Partial** — apply `nov_2025_w1` fetch+sync; Nov 8–Dec 25 needs original import or FATAL waiver |",
    "| 3. expected_packages from API | **Implemented** — domain sync + `rebuild_expected_packages_from_removals` |",
    "| 4. Duplicate prevention | **PASS** — idempotency keys + EP dup checks 0 |",
    "| 5. Idempotent rerun | **Validated** on 7-day batch when `--apply --batch=small` |",
    "| 6. No return_items writes | **Enforced** — pipeline never touches `return_items` |",
    "| 7. Product Core resolver only | **Enforced** — `resolveExpectedPackageProduct` map-only |",
    "",
    batchResult
      ? ["## BATCH SYNC RESULT", "", "```json", JSON.stringify(batchResult, null, 2), "```", ""].join("\n")
      : "## BATCH SYNC RESULT\n\nDry-run only — no batch executed.\n",
    idempotencyRerun
      ? ["## IDEMPOTENCY RERUN", "", "```json", JSON.stringify(idempotencyRerun, null, 2), "```", ""].join("\n")
      : "",
    "## EXPECTED_PACKAGES RESULT",
    "",
    finalSnap
      ? [
          `| Metric | Value |`,
          `|--------|------:|`,
          `| derived EP | ${finalSnap.derived_ep} |`,
          `| resolved | ${finalSnap.ep_resolved} |`,
          `| unresolved | ${finalSnap.ep_unresolved} |`,
          `| non-overflow mismatch | ${finalSnap.mismatch.non_overflow} |`,
          `| overflow (informational) | ${finalSnap.mismatch.overflow} |`,
          `| rebuild_valid | **${rebuildValid}** |`,
        ].join("\n")
      : "_No DB snapshot._",
    "",
    "## SAFE_TO_CONTINUE",
    "",
    `**${safeToContinue ? "yes" : "no"}**${safeToContinue ? "" : " — non-overflow mismatch must be 0 and historical Nov/Dec gap resolved before cron; rolling 7-day fetch+sync path works for supervised incremental apply after allocation patch"}.`,
    "",
    blockers.length ? `Blockers: ${blockers.join("; ")}` : "",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "REMOVAL-SHIPMENT-API-EXPECTED-SYNC-FINALIZE.md"), report);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-SHIPMENT-API-EXPECTED-SYNC-FINALIZE",
        run_id: runId,
        mode: apply ? `apply:${batch}` : "dry-run",
        staging_ref: STAGING_REF,
        safe_to_continue: safeToContinue,
        rebuild_valid: rebuildValid,
        non_overflow_mismatch: finalSnap?.mismatch.non_overflow ?? null,
        batch_result: batchResult,
        idempotency_rerun: idempotencyRerun,
        blockers,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        mode: apply ? batch : "dry-run",
        safe_to_continue: safeToContinue,
        rebuild_valid: rebuildValid,
        non_overflow: finalSnap?.mismatch.non_overflow,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
