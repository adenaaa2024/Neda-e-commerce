/**
 * PHASE-PREDEPLOY-ORIGINAL-API-EXPECTED-PACKAGES-NO-REGRESSION-V1 (read-only)
 *   npx tsx scripts/phase-predeploy-original-api-expected-packages-no-regression-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const OUT_BASE = ".cursor/audit-reports/phase-predeploy-original-api-expected-packages-no-regression-v1";

function sh(cmd: string): string {
  try {
    return execSync(cmd, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return `[error] ${err.message ?? String(e)}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
  }
}

function listRepoMigrations(): string[] {
  const migDir = path.join(process.cwd(), "supabase", "migrations");
  return fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

function classifyFile(f: string): string[] {
  const tags: string[] = [];
  if (/^app\/scanner\//.test(f) || /operator-mobile/.test(f)) tags.push("scanner");
  if (/removal|REMOVAL|amazon_removals|removal_shipment/.test(f)) tags.push("removal_worker");
  if (/expected.package|expected_packages|rebuild_expected_packages|removal-expected-packages/.test(f))
    tags.push("expected_packages_orchestration");
  if (/supabase\/migrations\//.test(f)) tags.push("migration");
  if (/rls|row level security|ENABLE ROW LEVEL SECURITY/i.test(f)) tags.push("rls_policy");
  if (/^lib\/amazon\/reports-api/.test(f)) tags.push("removal_worker");
  return tags;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = sh("git branch --show-current");
  const head = sh("git log -1 --oneline");
  const modifiedTracked = sh("git diff --name-only HEAD").split("\n").filter(Boolean);
  const untracked = sh("git ls-files --others --exclude-standard").split("\n").filter(Boolean);
  const branchChangedFiles = [...new Set([...modifiedTracked, ...untracked])].sort();

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const removals = await client.query(
    `SELECT count(*)::int AS row_count,
            max(created_at)::text AS max_created_at,
            max(coalesce(shipment_date, request_date))::text AS max_event_date
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );

  const shipments = await client.query(
    `SELECT count(*)::int AS row_count,
            max(created_at)::text AS max_created_at,
            max(shipment_date)::text AS max_event_date
     FROM public.amazon_removal_shipments
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );

  const stuckUploads = await client.query(
    `SELECT report_type, count(*)::int AS stuck_count
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'source_run'->>'state' = 'synthetic_upload_ready'
     GROUP BY report_type`,
    [ORG],
  );

  const epFresh = await client.query(
    `SELECT count(*)::int AS row_count,
            max(updated_at)::text AS max_updated_at
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );

  const inventoryView = await client.query(
    `SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation,
            disputed_statuses, total_expected, total_scanned, status
     FROM public.v_inventory_item_status
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(coalesce(tracking_number,'')) = $3
       AND upper(trim(coalesce(fnsku,''))) = $4`,
    [ORG, STORE, TRACKING, FNSKU],
  );

  const claimCandidates = await client.query(
    `SELECT count(*)::int AS row_count FROM public.claim_candidates WHERE organization_id = $1::uuid`,
    [ORG],
  );

  let appliedMigrations: string[] = [];
  try {
    const mig = await client.query(`SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`);
    appliedMigrations = mig.rows.map((r) => String((r as { version: string }).version));
  } catch {
    appliedMigrations = [];
  }

  await client.end();

  const repoMigrations = listRepoMigrations();
  const pendingOnOriginal = repoMigrations.filter((v) => !appliedMigrations.includes(v));
  const pendingRls = pendingOnOriginal.filter((v) => {
    const text = fs.readFileSync(path.join(process.cwd(), "supabase", "migrations", `${v}.sql`), "utf8");
    return /ENABLE ROW LEVEL SECURITY|CREATE POLICY|ALTER TABLE.*FORCE ROW LEVEL SECURITY/i.test(text);
  });

  const viewRow = inventoryView.rows[0] as Record<string, unknown> | undefined;
  const viewPass =
    viewRow &&
    Number(viewRow.expected_qty_clean) === 52 &&
    Number(viewRow.disputed_expected_qty) === 1 &&
    viewRow.needs_reconciliation === true;

  const stuckTotal = (stuckUploads.rows as { stuck_count: number }[]).reduce((s, r) => s + r.stuck_count, 0);

  const scannerFiles = branchChangedFiles.filter(
    (f) => /^app\/scanner\//.test(f) || /operator-mobile/.test(f),
  );
  const removalFiles = branchChangedFiles.filter((f) => classifyFile(f).includes("removal_worker"));
  const epFiles = branchChangedFiles.filter((f) => classifyFile(f).includes("expected_packages_orchestration"));
  const migrationFiles = branchChangedFiles.filter((f) => classifyFile(f).includes("migration"));

  const orchestratorDeployRisk =
    epFiles.length > 0
      ? "BEHAVIOR_CHANGE_ON_NEXT_REMOVAL_IMPORT — hook calls rebuild_expected_packages_from_removals after REMOVAL_* pipeline complete; idempotent per upload metadata; does NOT run on deploy idle"
      : "none";

  const originalNoRegression =
    Number(removals.rows[0]?.row_count) >= 3500 &&
    Number(shipments.rows[0]?.row_count) >= 11000 &&
    stuckTotal === 0 &&
    viewPass === true;

  const safeToPush =
    originalNoRegression &&
    scannerFiles.length === 0 &&
    migrationFiles.length === 0 &&
    pendingOnOriginal.length === 0;

  const requiredActions: string[] = [];
  if (epFiles.length > 0) {
    requiredActions.push(
      "Maysam approval before deploy: removal EP rebuild orchestrator hook (lib/amazon/reports-api-pipeline-handoff.ts + lib/removal/removal-expected-packages-rebuild-orchestrator.ts)",
    );
  }
  if (pendingOnOriginal.length > 0) {
    requiredActions.push(`${pendingOnOriginal.length} repo migrations not applied on original — do not auto-migrate without approval`);
  }
  if (pendingRls.length > 0) {
    requiredActions.push(`RLS/policy migrations pending on original: ${pendingRls.slice(0, 5).join(", ")}${pendingRls.length > 5 ? "…" : ""}`);
  }
  if (!viewPass) requiredActions.push("Investigate v_inventory_item_status target regression before push");

  const report = {
    run_id: runId,
    db: PRODUCTION_REF,
    mode: "read_only_predeploy",
    branch,
    head,
    original_snapshot: {
      amazon_removals: removals.rows[0],
      amazon_removal_shipments: shipments.rows[0],
      stuck_removal_uploads: stuckUploads.rows,
      stuck_removal_uploads_total: stuckTotal,
      expected_packages: epFresh.rows[0],
      v_inventory_item_status_target: {
        tracking: TRACKING,
        fnsku: FNSKU,
        row: viewRow ?? null,
        pass: viewPass,
        expected: { expected_qty_clean: 52, disputed_expected_qty: 1, needs_reconciliation: true },
      },
      claim_candidates_count: claimCandidates.rows[0]?.row_count,
    },
    branch_changed_files: branchChangedFiles,
    scanner_touch_report: {
      touched: scannerFiles,
      verdict: scannerFiles.length === 0 ? "UNTOUCHED" : "TOUCHED",
    },
    removal_worker_change_report: {
      files: removalFiles,
      notes:
        removalFiles.length === 0
          ? "No removal worker path changes in working tree"
          : "reports-api-pipeline-handoff.ts adds post-import EP rebuild hook for REMOVAL_ORDER/REMOVAL_SHIPMENT",
    },
    expected_packages_orchestration_change_report: {
      files: epFiles,
      deploy_behavior: orchestratorDeployRisk,
      guards: [
        "Only runs after pipeline domain_sync complete",
        "Skipped if metadata.import_metrics.expected_packages_rebuild_after_import already set for upload",
        "In-process dedupe per org/store/upload",
        "Does not run on deploy without a new removal import",
      ],
    },
    migration_risk_report: {
      applied_on_original_count: appliedMigrations.length,
      repo_migration_count: repoMigrations.length,
      pending_on_original: pendingOnOriginal,
      pending_rls_migrations: pendingRls,
      changed_migration_files_in_branch: migrationFiles,
      auto_apply_on_deploy: "none unless CI/CD runs supabase db push without gate",
    },
    original_no_regression_verdict: originalNoRegression ? "PASS" : "FAIL",
    SAFE_TO_PUSH_WITHOUT_ORIGINAL_API_BREAK: safeToPush ? "yes" : "conditional_no",
    required_actions_before_push: requiredActions,
    NEXT_PROMPT: safeToPush
      ? "PHASE-DEPLOY-ORIGINAL-VERIFY-POST-PUSH-SNAPSHOT-V1"
      : "PHASE-REMOVAL-SYNC-EXPECTED-PACKAGES-REBUILD-ORCHESTRATOR-V1-ORIGINAL-APPLY — Maysam approval for orchestrator deploy + post-push snapshot",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "committed_vs_uncommitted.json"),
    JSON.stringify(
      {
        committed_head: head,
        uncommitted_only: branchChangedFiles.filter((f) => modifiedTracked.includes(f)),
        committed_scanner_in_head: sh('git diff HEAD~1 HEAD --name-only -- "app/scanner/**" "**/operator-mobile/**"')
          .split("\n")
          .filter(Boolean),
        committed_removal_in_head: sh(
          'git diff HEAD~1 HEAD --name-only -- "lib/amazon/reports-api-removal*" "lib/amazon/reports-api-pipeline-handoff.ts"',
        )
          .split("\n")
          .filter(Boolean),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "audit-report.md"),
    `# Predeploy original no-regression verify

Branch: \`${branch}\` · ${head}

## Original snapshot — PASS criteria
- amazon_removals: **${removals.rows[0]?.row_count}** (max event ${removals.rows[0]?.max_event_date})
- amazon_removal_shipments: **${shipments.rows[0]?.row_count}** (max event ${shipments.rows[0]?.max_event_date})
- stuck REMOVAL uploads: **${stuckTotal}**
- expected_packages max updated_at: **${epFresh.rows[0]?.max_updated_at}**
- target view 52/1: **${viewPass ? "PASS" : "FAIL"}**

## Verdict
- **original_no_regression:** ${report.original_no_regression_verdict}
- **SAFE_TO_PUSH_WITHOUT_ORIGINAL_API_BREAK:** ${report.SAFE_TO_PUSH_WITHOUT_ORIGINAL_API_BREAK}
`,
  );

  console.log(JSON.stringify({ ok: true, outDir, verdict: report.original_no_regression_verdict, safe: report.SAFE_TO_PUSH_WITHOUT_ORIGINAL_API_BREAK }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
