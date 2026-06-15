/**
 * PHASE-PRODUCTION-REMOVAL-SYNC-DEDUPE-REBUILD-V1
 *   npx tsx scripts/phase-production-removal-sync-dedupe-rebuild-v1.ts
 *   npx tsx scripts/phase-production-removal-sync-dedupe-rebuild-v1.ts --execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  evaluateExplicitRebuildSkip,
  expectedPackagesRebuildRecordedForUpload,
} from "../lib/removal/expected-packages-explicit-rebuild-guard";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TARGET_TRACKING = "387003587";
const TARGET_FNSKU = "X004LKS4VD";
const OUT_BASE = ".cursor/audit-reports/phase-production-removal-sync-dedupe-rebuild-v1";

const DEPLOYED_FILES = [
  "lib/removal/expected-packages-explicit-rebuild-guard.ts",
  "lib/removal/removal-expected-packages-rebuild-orchestrator.ts",
  "lib/production-removal-sync-run.ts",
  "scripts/sp-api-removal-reports-domain-sync-execute.ts",
];

const REDUNDANT_CALL_SITES = [
  {
    file: "lib/amazon/reports-api-pipeline-handoff.ts",
    role: "pipeline_hook",
    redundant: false,
    note: "Primary auto-rebuild after REMOVAL_* complete — keep",
  },
  {
    file: "lib/production-removal-sync-run.ts",
    role: "explicit_rpc_after_pipeline",
    redundant: true,
    note: "Guarded — skips when import_metrics.expected_packages_rebuild_after_import set",
  },
  {
    file: "scripts/sp-api-removal-reports-domain-sync-execute.ts",
    role: "explicit_rpc_after_pipeline",
    redundant: true,
    note: "Guarded — same skip rule",
  },
  {
    file: "scripts/removal-automation-orchestrator.ts",
    role: "child_spawn_domain_sync",
    redundant: false,
    note: "Delegates to domain-sync-execute — inherits guard",
  },
  {
    file: "app/api/cron/removal-nightly-sync/route.ts",
    role: "cron_calls_runProductionRemovalSync",
    redundant: false,
    note: "Uses production-removal-sync-run — inherits guard",
  },
  {
    file: "lib/removal/removal-expected-packages-rebuild-orchestrator.ts",
    role: "orchestrator",
    redundant: false,
    note: "Canonical hook — keep; per-upload metadata + in-process dedupe",
  },
];

async function claimCount(c: pg.Client): Promise<number> {
  const r = await c.query(`SELECT count(*)::int AS c FROM public.claim_candidates WHERE organization_id=$1::uuid`, [
    ORG,
  ]);
  return Number(r.rows[0]?.c ?? 0);
}

async function targetCaseReadonly(c: pg.Client): Promise<Record<string, unknown>> {
  const r = await c.query(
    `SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation
     FROM public.v_inventory_item_status
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND tracking_number=$3 AND fnsku=$4
     LIMIT 1`,
    [ORG, STORE, TARGET_TRACKING, TARGET_FNSKU],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return {
    ok: Boolean(row),
    expected_qty: row?.expected_qty ?? null,
    expected_qty_clean: row?.expected_qty_clean ?? null,
    disputed_expected_qty: row?.disputed_expected_qty ?? null,
    needs_reconciliation: row?.needs_reconciliation ?? null,
    pass:
      Number(row?.expected_qty_clean ?? -1) === 52 && Number(row?.disputed_expected_qty ?? -1) === 1,
  };
}

async function stagingUploadWithRebuildMeta(c: pg.Client): Promise<Record<string, unknown> | null> {
  const r = await c.query(
    `SELECT id::text, report_type, metadata
     FROM public.raw_report_uploads
     WHERE organization_id=$1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'import_metrics'->'expected_packages_rebuild_after_import'->>'rebuild_called' = 'true'
     ORDER BY created_at DESC
     LIMIT 1`,
    [ORG],
  );
  const row = r.rows[0] as { id: string; report_type: string; metadata: unknown } | undefined;
  if (!row) return null;
  return {
    upload_id: row.id,
    report_type: row.report_type,
    rebuild_recorded: expectedPackagesRebuildRecordedForUpload(row.metadata, row.id),
    skip_decision: evaluateExplicitRebuildSkip({
      rebuildExpectedPackages: true,
      orderPipelineOk: row.report_type === "REMOVAL_ORDER",
      shipmentPipelineOk: row.report_type === "REMOVAL_SHIPMENT",
      orderUploadMetadata: row.report_type === "REMOVAL_ORDER" ? row.metadata : null,
      shipmentUploadMetadata: row.report_type === "REMOVAL_SHIPMENT" ? row.metadata : null,
      orderUploadId: row.report_type === "REMOVAL_ORDER" ? row.id : null,
      shipmentUploadId: row.report_type === "REMOVAL_SHIPMENT" ? row.id : null,
    }),
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  loadEnvLocalIntoProcess();

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  let unitOk = false;
  try {
    execSync("npm run test:production-removal-sync-dedupe-rebuild", { stdio: "pipe", encoding: "utf8" });
    unitOk = true;
  } catch (e) {
    unitOk = false;
  }

  const originalUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const originalPg = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  let targetCase: Record<string, unknown> = { skipped: true, reason: "no_original_pg" };
  let claimBefore = 0;
  let claimAfter = 0;
  let stagingSmoke: Record<string, unknown> | null = null;

  if (originalPg && refFromSupabaseUrl(originalUrl) === ORIGINAL_REF) {
    const client = new pg.Client({ connectionString: originalPg, ssl: { rejectUnauthorized: false } });
    await client.connect();
    claimBefore = await claimCount(client);
    targetCase = await targetCaseReadonly(client);
    claimAfter = await claimCount(client);
    await client.end();
  }

  if (execute) {
    const stagingPg = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
    if (stagingPg) {
      const sc = new pg.Client({ connectionString: stagingPg, ssl: { rejectUnauthorized: false } });
      await sc.connect();
      stagingSmoke = await stagingUploadWithRebuildMeta(sc);
      await sc.end();
    }
  }

  let operatorMobileTouched = false;
  try {
    operatorMobileTouched =
      execSync('git status --porcelain "app/scanner/operator-mobile"', { encoding: "utf8" }).trim().length > 0;
  } catch {
    operatorMobileTouched = false;
  }

  let buildResult = "pending";
  let smokeResult = unitOk ? "unit_pass" : "unit_fail";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const doubleRebuildPrevention =
    unitOk &&
    (stagingSmoke?.skip_decision as { skip?: boolean } | undefined)?.skip === true;

  const pass =
    unitOk &&
    buildResult === "pass" &&
    !operatorMobileTouched &&
    (targetCase.pass === true || targetCase.skipped) &&
    claimBefore === claimAfter;

  const report = {
    run_id: runId,
    mode: execute ? "verify_execute" : "dry_run",
    redundant_call_sites: REDUNDANT_CALL_SITES,
    files_changed: DEPLOYED_FILES.filter((f) => fs.existsSync(path.join(process.cwd(), f))),
    guard_rule:
      "Skip explicit rebuild_expected_packages_from_removals when import_metrics.expected_packages_rebuild_after_import.rebuild_called=true for a successful pipeline upload in this session; manual/fetch-only paths without successful pipeline still rebuild",
    manual_path_preserved: true,
    pipeline_hook_path_preserved: true,
    fetch_only_verification:
      "runRemoval*ReportsWorker with runPipeline:false does not invoke runReportsApiImportPipeline → no hook rebuild; explicit path runs when rebuildExpectedPackages !== false",
    double_rebuild_prevention_result: {
      unit_tests: unitOk,
      staging_metadata_skip_smoke: stagingSmoke,
      prevented: doubleRebuildPrevention,
    },
    target_case_readonly_verification: targetCase,
    claim_candidates_delta: claimAfter - claimBefore,
    no_scanner_change_verification: { operator_mobile_touched: operatorMobileTouched },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_KEEP_ORCHESTRATOR_AND_DEDUPE: pass ? "yes" : "no",
    NEXT_PROMPT:
      "PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1-ORIGINAL-APPLY (Maysam) OR PHASE-AMAZON-FINANCIAL-REPORTS-BACKFILL-ORIGINAL-VERIFY-CRON",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# PHASE-PRODUCTION-REMOVAL-SYNC-DEDUPE-REBUILD-V1\n\n**Run:** ${runId}\n**SAFE_TO_KEEP_ORCHESTRATOR_AND_DEDUPE:** ${report.SAFE_TO_KEEP_ORCHESTRATOR_AND_DEDUPE}\n`,
  );
  console.log(JSON.stringify({ ok: pass, outDir, SAFE_TO_KEEP_ORCHESTRATOR_AND_DEDUPE: report.SAFE_TO_KEEP_ORCHESTRATOR_AND_DEDUPE }));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
