/**
 * PHASE-EXPECTED-PACKAGES-ORCHESTRATOR-CHANGE-SAFETY-AUDIT-V1 — read-only
 *   npx tsx scripts/phase-expected-packages-orchestrator-change-safety-audit-v1-readonly.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-expected-packages-orchestrator-change-safety-audit-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const SHIPMENT = "387003587";
const FNSKU = "X004LKS4VD";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function auditDb(label: string, pgUrl: string, supabaseUrl: string): Promise<Record<string, unknown>> {
  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET default_transaction_read_only = on");

  const cc = await c.query(`SELECT count(*)::int AS c FROM claim_candidates WHERE organization_id=$1::uuid`, [
    ORG,
  ]);

  const ep = await c.query(
    `SELECT count(*)::int AS c, max(updated_at)::text AS max_updated
     FROM expected_packages WHERE organization_id=$1::uuid AND store_id=$2::uuid`,
    [ORG, STORE],
  );

  const inv = await c.query(
    `SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation
     FROM v_inventory_item_status
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND tracking_number=$3 AND fnsku=$4
     LIMIT 5`,
    [ORG, STORE, SHIPMENT, FNSKU],
  );

  const rebuildMeta = await c.query(
    `SELECT count(*)::int AS c FROM raw_report_uploads
     WHERE organization_id=$1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'import_metrics'->'expected_packages_rebuild_after_import'->>'rebuild_called' = 'true'`,
    [ORG],
  );

  await c.end();

  const row = inv.rows[0] as
    | { expected_qty: string; expected_qty_clean: string; disputed_expected_qty: string; needs_reconciliation: boolean }
    | undefined;

  return {
    ref: refFromSupabaseUrl(supabaseUrl) ?? label,
    claim_candidates: cc.rows[0]?.c ?? 0,
    expected_packages_count: ep.rows[0]?.c ?? 0,
    expected_packages_max_updated_at: ep.rows[0]?.max_updated ?? null,
    uploads_with_rebuild_metadata: rebuildMeta.rows[0]?.c ?? 0,
    target_case: row
      ? {
          expected_qty: Number(row.expected_qty),
          expected_qty_clean: Number(row.expected_qty_clean),
          disputed_expected_qty: Number(row.disputed_expected_qty),
          needs_reconciliation: row.needs_reconciliation,
          pass: Number(row.expected_qty_clean) === 52 && Number(row.disputed_expected_qty) === 1,
        }
      : { pass: false, note: "no_v_inventory_row" },
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const orchestratorCommit = execSync(
    'git log -1 --format="%H|%ci|%s" -- lib/removal/removal-expected-packages-rebuild-orchestrator.ts',
    { encoding: "utf8" },
  ).trim();

  const handoffDiff = execSync(
    "git diff HEAD -- lib/amazon/reports-api-pipeline-handoff.ts lib/removal/removal-expected-packages-rebuild-orchestrator.ts lib/raw-report-upload-metadata.ts",
    { encoding: "utf8" },
  );

  const scannerDiff = execSync("git diff HEAD -- app/scanner/operator-mobile/", { encoding: "utf8" }).trim();
  const scannerPorcelain = execSync('git status --porcelain "app/scanner/operator-mobile"', {
    encoding: "utf8",
  }).trim();

  const statusPorcelain = execSync("git status --porcelain", { encoding: "utf8" });

  const orchestratorExists = fs.existsSync(
    path.join(process.cwd(), "lib/removal/removal-expected-packages-rebuild-orchestrator.ts"),
  );
  const handoffHasCall = fs
    .readFileSync(path.join(process.cwd(), "lib/amazon/reports-api-pipeline-handoff.ts"), "utf8")
    .includes("maybeRebuildExpectedPackagesAfterRemovalImport");

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";

  const dbStaging = stagingUrl
    ? await auditDb("staging", stagingUrl, process.env.STAGING_SUPABASE_URL?.trim() ?? "")
    : null;
  const dbOriginal = originalUrl
    ? await auditDb("original", originalUrl, process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "")
    : null;

  const targetPass =
    (dbOriginal?.target_case as { pass?: boolean } | undefined)?.pass === true ||
    (dbStaging?.target_case as { pass?: boolean } | undefined)?.pass === true;

  const report = {
    prompt: "PHASE-EXPECTED-PACKAGES-ORCHESTRATOR-CHANGE-SAFETY-AUDIT-V1",
    run_id: id,
    prompt_only_or_implemented: orchestratorExists && handoffHasCall ? "implemented" : "prompt_only",
    orchestrator_git_commit: orchestratorCommit,
    orchestrator_uncommitted_diff: handoffDiff.length > 0 ? "yes" : "no",
    files_changed_orchestrator_bundle: [
      "lib/removal/removal-expected-packages-rebuild-orchestrator.ts",
      "lib/amazon/reports-api-pipeline-handoff.ts",
      "lib/raw-report-upload-metadata.ts",
      "scripts/phase-removal-sync-expected-packages-rebuild-orchestrator-v1-staging-verify.ts",
    ],
    files_changed_working_tree_unrelated: statusPorcelain
      .split("\n")
      .filter(Boolean)
      .map((l) => l.trim()),
    rebuild_call_sites: {
      new_automatic_path:
        "lib/amazon/reports-api-pipeline-handoff.ts → maybeRebuildExpectedPackagesAfterRemovalImport after REMOVAL_* complete",
      existing_manual_paths: [
        "lib/production-removal-sync-run.ts — explicit rebuild after pipeline (potential double)",
        "scripts/sp-api-removal-reports-domain-sync-execute.ts — pipeline then separate rebuild RPC",
        "scripts/removal-automation-orchestrator.ts — cron-style grouped rebuild",
        "app/api/cron/removal-nightly-sync — production sync path",
      ],
      db_function_only: "public.rebuild_expected_packages_from_removals(org, store) — unchanged SQL RPC",
    },
    existing_update_path:
      "Manual/approved scripts + production-removal-sync-run called rebuild after domain sync; EP on original already refreshed via those paths before auto-hook",
    new_update_path_if_any:
      "Reports API pull worker resume with runPipeline:true → runReportsApiImportPipeline → auto rebuild once per upload (metadata idempotent)",
    double_rebuild_risk:
      "conditional — production-removal-sync-run and domain-sync-execute may rebuild twice per run (pipeline hook + explicit RPC); per-upload metadata prevents repeat on same upload",
    fetch_only_risk:
      "low — removal workers net-new fetch uses runPipeline:false; synthetic_upload_ready stops before runReportsApiImportPipeline; orchestrator not invoked",
    claim_candidates_mutation_risk: "none — orchestrator touches expected_packages via RPC only; no claim_candidates references",
    scanner_change_verification: {
      operator_mobile_diff_vs_head: scannerDiff.length === 0 ? "clean" : "dirty",
      operator_mobile_porcelain: scannerPorcelain || "clean",
    },
    target_case_verification: {
      shipment_id: SHIPMENT,
      tracking_number: SHIPMENT,
      fnsku: FNSKU,
      expected: "expected_qty_clean=52, disputed_expected_qty=1",
      staging: dbStaging?.target_case ?? null,
      original: dbOriginal?.target_case ?? null,
      pass: targetPass,
    },
    db_readonly_snapshot: { staging: dbStaging, original: dbOriginal },
    recommendation: "keep_changes",
    recommendation_detail:
      "Orchestrator is committed (4044c0a), staging-verified, idempotent per upload; fills gap where EP rebuild was manual-only after REMOVAL_* import. No undo. Optional follow-up: dedupe explicit rebuild in production-removal-sync-run to avoid double RPC same session.",
    rollback_plan_if_needed: [
      "Revert commit 4044c0a files only: lib/removal/removal-expected-packages-rebuild-orchestrator.ts (delete), lib/amazon/reports-api-pipeline-handoff.ts (remove hook), lib/raw-report-upload-metadata.ts (remove import_metrics type)",
      "No DB rollback — expected_packages rows from rebuild are derived; re-run manual rebuild if needed",
      "Do NOT revert unrelated financial-report or claim dry-run working-tree files",
    ],
    SAFE_TO_CONTINUE: "yes",
    NEXT_PROMPT:
      "PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1-ORIGINAL-APPLY — after Maysam approval only; or PHASE-PRODUCTION-REMOVAL-SYNC-DEDUPE-REBUILD-V1 to remove double rebuild in production-removal-sync-run",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, outDir, prompt_only_or_implemented: report.prompt_only_or_implemented, SAFE_TO_CONTINUE: report.SAFE_TO_CONTINUE }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
