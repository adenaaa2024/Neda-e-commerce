/**
 * PHASE1-API-SYNC-RECENT-TO-TODAY-STAGING-VERIFY
 * Staging API verify — dry-run then optional small apply + idempotency.
 *
 *   npx tsx scripts/phase1-api-sync-recent-to-today-staging-verify.ts
 *   npx tsx scripts/phase1-api-sync-recent-to-today-staging-verify.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import pg from "pg";

import {
  isAmazonFinancesApiIngestEnabled,
  isAmazonFinancesApiWorkerEnabled,
} from "../lib/amazon/finances-api-worker-flags";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiRemovalOrderEnabled,
  isAmazonReportsApiRemovalShipmentEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
} from "../lib/amazon/reports-api-worker-flags";
import { readPlatformAutomationSettingsFromPg } from "../lib/platform-automation-settings-read";
import {
  queryEpAllocationMismatchBreakdown,
  rebuildValidFromBreakdown,
} from "../lib/removal/ep-allocation-mismatch-breakdown";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase1-api-sync-recent-to-today-staging-verify";
const WINDOW_CURSOR = ".cursor/audit-reports/removal-automation-run/.window-cursor.json";
const SMALL_BATCH_DAYS = 7;
const RECOMMENDED_ROLLING_DAYS = 90;

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
  ep_resolved: number;
  return_items: number;
  dup_business_key: number;
  upload_idem_dup: number;
  mismatch_non_overflow: number;
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

function readApprovalFlags(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of APPROVALS) {
    const text = fs.existsSync(path.join(process.cwd(), p)) ? fs.readFileSync(path.join(process.cwd(), p), "utf8") : "";
    out[p] = /APPROVED.*=\s*true/i.test(text);
  }
  return out;
}

function apiFlags(): Record<string, boolean | string> {
  loadEnvLocalIntoProcess();
  return {
    AMAZON_SP_API_ENABLED: process.env.AMAZON_SP_API_ENABLED?.trim() === "true",
    ENABLE_AMAZON_REPORTS_API_WORKER: isAmazonReportsApiWorkerEnabled(),
    ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER: isAmazonReportsApiRemovalOrderEnabled(),
    ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT: isAmazonReportsApiRemovalShipmentEnabled(),
    ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS: isAmazonReportsApiReimbursementsEnabled(),
    ENABLE_AMAZON_REPORTS_API_SETTLEMENT: isAmazonReportsApiSettlementEnabled(),
    ENABLE_AMAZON_FINANCES_API_WORKER: isAmazonFinancesApiWorkerEnabled(),
    ENABLE_AMAZON_FINANCES_API_INGEST: isAmazonFinancesApiIngestEnabled(),
    REMOVAL_AUTOMATION_APPLY_ENABLED: process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim() === "true",
    REMOVAL_AUTOMATION_CONFIRM_APPLY: process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim() === "true",
  };
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
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NOT NULL) AS ep_resolved,
       (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS return_items,
       (SELECT COUNT(*)::int FROM (
          SELECT source_detail_row_id, source_shipment_row_id, build_source, allocation_group_key
          FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')
          GROUP BY 1,2,3,4 HAVING count(*)>1
        ) x) AS dup_business_key,
       (SELECT COUNT(*)::int FROM (
          SELECT metadata->'source_run'->>'idempotency_key' AS k FROM public.raw_report_uploads
          WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
            AND metadata->'source_run'->>'idempotency_key' IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1
        ) x) AS upload_idem_dup,
       (SELECT max(order_date)::text FROM public.amazon_removals WHERE organization_id=$1::uuid) AS max_order_date`,
    [ORG_ID],
  );
  const row = r.rows[0] as Record<string, number | string | null>;
  const mismatch = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
  return {
    removals: Number(row.removals),
    shipments: Number(row.shipments),
    derived_ep: Number(row.derived_ep),
    ep_resolved: Number(row.ep_resolved),
    return_items: Number(row.return_items),
    dup_business_key: Number(row.dup_business_key),
    upload_idem_dup: Number(row.upload_idem_dup),
    mismatch_non_overflow: mismatch.non_overflow,
    max_order_date: row.max_order_date as string | null,
  };
}

function runOrchestrator(runId: string, apply: boolean): { ok: boolean; stdout: string } {
  const argv = [
    "tsx",
    "scripts/removal-automation-orchestrator.ts",
    `--run-id=${runId}`,
    `--rolling-days=${SMALL_BATCH_DAYS}`,
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
  });
  const stdout = (res.stdout ?? "") + (res.stderr ?? "");
  return { ok: res.status === 0, stdout };
}

function readFetchRows(runId: string): { order_rows: number; shipment_rows: number } {
  const manifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/sp-api-removal-reports-fetch-execute",
    `${runId}-fetch`,
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return { order_rows: 0, shipment_rows: 0 };
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    return {
      order_rows: Number(m.order_report_rows ?? m.order_rows ?? 0),
      shipment_rows: Number(m.shipment_report_rows ?? m.shipment_rows ?? 0),
    };
  } catch {
    return { order_rows: 0, shipment_rows: 0 };
  }
}

function readSyncApplied(runId: string): { new_order_rows: number; new_shipment_rows: number; ep_delta: number } {
  const manifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/sp-api-removal-reports-domain-sync-execute",
    `${runId}-sync`,
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return { new_order_rows: 0, new_shipment_rows: 0, ep_delta: 0 };
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const before = Number(m.expected_packages_before ?? 0);
    const after = Number(m.expected_packages_after ?? 0);
    return {
      new_order_rows: Number(m.new_order_rows ?? 0),
      new_shipment_rows: Number(m.new_shipment_rows ?? 0),
      ep_delta: after - before,
    };
  } catch {
    return { new_order_rows: 0, new_shipment_rows: 0, ep_delta: 0 };
  }
}

function readResolverApplied(runId: string): number {
  const p = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-post-sync-resolver-reconcile",
    `${runId}-resolver`,
    "manifest.json",
  );
  if (!fs.existsSync(p)) return 0;
  try {
    const m = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    return Number(m.applied_update_count ?? 0);
  } catch {
    return 0;
  }
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
  if (process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim() === "true") {
    blockers.push("REMOVAL_AUTOMATION_APPLY_ENABLED must stay off");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");

  const flags = apiFlags();
  const approvals = readApprovalFlags();
  const approvalsReady = Object.values(approvals).every(Boolean);

  let automationSettings = null;
  let before: Snapshot | null = null;
  if (dbUrl && !blockers.length) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    automationSettings = await readPlatformAutomationSettingsFromPg(client);
    before = await snapshot(client);
    await client.end();
  }

  const windowCursor = fs.existsSync(WINDOW_CURSOR)
    ? JSON.parse(fs.readFileSync(WINDOW_CURSOR, "utf8"))
    : null;

  const manualWiring = {
    org_id: ORG_ID,
    store_id: STORE_ID,
    path: "removal-automation-orchestrator.ts --manual [--apply]",
    platform_automation_schedules_enabled: automationSettings
      ? {
          product_enrichment: automationSettings.product_enrichment.enabled,
          removal_recent: automationSettings.removal_api_sync.enabled,
          historical_backfill: automationSettings.removal_api_sync.historical_backfill.enabled,
        }
      : null,
    historical_backfill_off: automationSettings
      ? !automationSettings.removal_api_sync.historical_backfill.enabled
      : null,
    recommended_rolling_days: RECOMMENDED_ROLLING_DAYS,
    configured_rolling_days: automationSettings?.removal_api_sync.recent_sync.rolling_days ?? SMALL_BATCH_DAYS,
  };

  const cardsScope = {
    removal_shipment_sync: "in_scope",
    reimbursements: flags.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS ? "enabled_in_env" : "skipped_flag_off",
    settlement: flags.ENABLE_AMAZON_REPORTS_API_SETTLEMENT ? "enabled_in_env" : "skipped_flag_off",
    finances: flags.ENABLE_AMAZON_FINANCES_API_INGEST ? "enabled_in_env" : "skipped_flag_off",
  };

  let dryRunOk = false;
  let dryRunStdout = "";
  if (!blockers.length) {
    const dr = runOrchestrator(`${runId}-dryrun`, false);
    dryRunOk = dr.ok;
    dryRunStdout = dr.stdout;
    if (!dryRunOk) blockers.push("Dry-run orchestrator failed");
  }

  let applyResult: Record<string, unknown> | null = null;
  let after: Snapshot | null = null;
  let idempotency: Record<string, unknown> | null = null;

  const canApply =
    applyRequested &&
    dryRunOk &&
    approvalsReady &&
    process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim() === "true" &&
    !blockers.length;

  if (canApply) {
    const r1 = runOrchestrator(`${runId}-apply`, true);
    if (!r1.ok) blockers.push("Apply orchestrator run 1 failed");

    if (dbUrl) {
      const c2 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await c2.connect();
      after = await snapshot(c2);
      await c2.end();
    }

    const sync1 = readSyncApplied(`${runId}-apply`);
    const resolver1 = readResolverApplied(`${runId}-apply`);

    const r2 = runOrchestrator(`${runId}-idem`, true);
    let afterIdem: Snapshot | null = null;
    if (dbUrl) {
      const c3 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await c3.connect();
      afterIdem = await snapshot(c3);
      await c3.end();
    }

    idempotency = {
      run2_ok: r2.ok,
      delta_removals: (afterIdem?.removals ?? 0) - (after?.removals ?? 0),
      delta_shipments: (afterIdem?.shipments ?? 0) - (after?.shipments ?? 0),
      delta_derived_ep: (afterIdem?.derived_ep ?? 0) - (after?.derived_ep ?? 0),
      delta_return_items: (afterIdem?.return_items ?? 0) - (before!.return_items),
      stable:
        afterIdem?.removals === after?.removals &&
        afterIdem?.shipments === after?.shipments &&
        afterIdem?.derived_ep === after?.derived_ep,
    };

    applyResult = {
      run1_ok: r1.ok,
      fetch: readFetchRows(`${runId}-apply`),
      sync: sync1,
      resolver_updates: resolver1,
      resolver_note: "map-only Product Core resolver — no product auto-create",
    };
  } else if (applyRequested) {
    blockers.push(
      "Apply skipped — need --apply, dry-run PASS, approvals ready, REMOVAL_AUTOMATION_CONFIRM_APPLY=true",
    );
  }

  const finalSnap = after ?? before;
  const rebuildValid = finalSnap ? finalSnap.mismatch_non_overflow === 0 : false;
  const dupOk = finalSnap ? finalSnap.dup_business_key === 0 : false;
  const returnItemsOk = before && finalSnap ? finalSnap.return_items === before.return_items : true;
  const idemOk = idempotency ? idempotency.stable === true : null;

  const safeToContinue =
    !blockers.length &&
    dryRunOk &&
    rebuildValid &&
    dupOk &&
    returnItemsOk &&
    (idemOk === null || idemOk === true);

  const report = {
    prompt: "PHASE1-API-SYNC-RECENT-TO-TODAY-STAGING-VERIFY",
    run_id: runId,
    staging_ref: STAGING_REF,
    API_FLAGS: flags,
    cards_scope: cardsScope,
    LAST_SUCCESSFUL_RUN: windowCursor,
    manual_wiring: manualWiring,
    approvals,
    dry_run: { ok: dryRunOk, rolling_days: SMALL_BATCH_DAYS },
    apply: applyResult,
    idempotency,
    EXPECTED_PACKAGES_BEFORE_AFTER: before && finalSnap
      ? { before: before.derived_ep, after: finalSnap.derived_ep, delta: finalSnap.derived_ep - before.derived_ep }
      : null,
    DUPLICATE_PREVENTION_RESULT: finalSnap
      ? { dup_business_key: finalSnap.dup_business_key, upload_idem_dup_keys: finalSnap.upload_idem_dup, pass: dupOk }
      : null,
    RETURN_ITEMS_UNCHANGED_CONFIRMATION: before && finalSnap
      ? { before: before.return_items, after: finalSnap.return_items, unchanged: returnItemsOk }
      : null,
    NEXT_SCHEDULE_RECOMMENDATION:
      "Keep platform automation schedules disabled; use supervised `--manual --apply --rolling-days=90` burn-in before cron; historical backfill remains off until Nov/Dec gap closed",
    blockers,
    safe_to_continue: safeToContinue,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "PHASE1-API-SYNC-RECENT-TO-TODAY-STAGING-VERIFY.md"),
    [
      "# PHASE1-API-SYNC-RECENT-TO-TODAY-STAGING-VERIFY",
      "",
      `Run: \`${runId}\` · Staging \`${STAGING_REF}\``,
      "",
      "## API_FLAGS",
      "",
      "```json",
      JSON.stringify(flags, null, 2),
      "```",
      "",
      "## LAST_SUCCESSFUL_RUN",
      "",
      "```json",
      JSON.stringify(windowCursor, null, 2),
      "```",
      "",
      "## ROWS_FETCHED / ROWS_APPLIED",
      "",
      applyResult
        ? "```json\n" + JSON.stringify(applyResult, null, 2) + "\n```"
        : "_Dry-run only — no apply executed._",
      "",
      "## EXPECTED_PACKAGES_BEFORE_AFTER",
      "",
      report.EXPECTED_PACKAGES_BEFORE_AFTER
        ? `| Before | After | Delta |\n|------:|------:|------:|\n| ${before!.derived_ep} | ${finalSnap!.derived_ep} | ${finalSnap!.derived_ep - before!.derived_ep} |`
        : "_N/A_",
      "",
      "## DUPLICATE_PREVENTION_RESULT",
      "",
      JSON.stringify(report.DUPLICATE_PREVENTION_RESULT, null, 2),
      "",
      "## RETURN_ITEMS_UNCHANGED_CONFIRMATION",
      "",
      JSON.stringify(report.RETURN_ITEMS_UNCHANGED_CONFIRMATION, null, 2),
      "",
      "## NEXT_SCHEDULE_RECOMMENDATION",
      "",
      report.NEXT_SCHEDULE_RECOMMENDATION,
      "",
      "## SAFE_TO_CONTINUE",
      "",
      `**${safeToContinue ? "yes" : "no"}**`,
      "",
      blockers.length ? `Blockers: ${blockers.join("; ")}` : "",
    ].join("\n"),
  );

  console.log(JSON.stringify({ ok: safeToContinue, outDir, safe_to_continue: safeToContinue, blockers }, null, 2));
  if (!safeToContinue && applyRequested) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
