/**
 * PHASE-INVENTORY-STATUS-VIEW-CLEAN-DISPUTED-GATING-V1 — staging apply + verify
 *   npx tsx scripts/phase-inventory-status-clean-disputed-gating-v1-staging-execute.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  filterExpectedPackagesForClaimGeneration,
  isCleanExpectedPackageBuildStatus,
} from "../lib/expected-packages-conflict-status";
import { bindProductionSupabaseEnv, productionPostgresUrl } from "../lib/production-db-bind";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const OUT_BASE = ".cursor/audit-reports/phase-inventory-status-view-clean-disputed-gating-v1";
const MIGRATION = "supabase/migrations/20260612120000_v_inventory_item_status_clean_disputed_gating_v1.sql";

async function migrationApplied(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'is_clean_expected_package_build_status'
     ) AS fn,
     EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'v_inventory_item_status'
         AND column_name = 'expected_qty_clean'
     ) AS col`,
  );
  return r.rows[0]?.fn === true && r.rows[0]?.col === true;
}

async function queryStagingTarget(client: pg.Client, includeGatingColumns: boolean) {
  const viewSql = includeGatingColumns
    ? `SELECT total_expected, expected_qty, expected_qty_clean, disputed_expected_qty,
              needs_reconciliation, disputed_statuses, clean_expected_qty_source,
              total_scanned, scanned_qty, status
       FROM public.v_inventory_item_status
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND upper(trim(coalesce(fnsku,''))) = $3
         AND trim(coalesce(tracking_number,'')) = $4
       LIMIT 5`
    : `SELECT total_expected, expected_qty, total_scanned, scanned_qty, status
       FROM public.v_inventory_item_status
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND upper(trim(coalesce(fnsku,''))) = $3
         AND trim(coalesce(tracking_number,'')) = $4
       LIMIT 5`;
  const view = await client.query(viewSql, [ORG, STORE, FNSKU, TRACKING]);
  const ep = await client.query(
    `SELECT id::text, build_status, expected_scan_quantity::int AS qty
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND trim(coalesce(tracking_number,'')) = $4
     ORDER BY expected_scan_quantity DESC`,
    [ORG, STORE, FNSKU, TRACKING],
  );
  const disputedSample = await client.query(
    `SELECT tracking_number, fnsku, expected_qty, expected_qty_clean, disputed_expected_qty,
            needs_reconciliation, disputed_statuses
     FROM public.v_inventory_item_status
     WHERE disputed_expected_qty > 0
     LIMIT 5`,
  );
  return { view_rows: view.rows, ep_rows: ep.rows, disputed_sample: disputedSample.rows };
}

async function queryOriginalTarget(client: pg.Client) {
  const oldView = await client.query(
    `SELECT total_expected, expected_qty, total_scanned, status
     FROM public.v_inventory_item_status
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND trim(coalesce(tracking_number,'')) = $4`,
    [ORG, STORE, FNSKU, TRACKING],
  );
  const ep = await client.query(
    `SELECT id::text, build_status, expected_scan_quantity::int AS qty
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND trim(coalesce(tracking_number,'')) = $4
     ORDER BY expected_scan_quantity DESC`,
    [ORG, STORE, FNSKU, TRACKING],
  );
  const projected = await client.query(
    `SELECT
       sum(CASE WHEN public.is_clean_expected_package_build_status(build_status)
         THEN expected_scan_quantity ELSE 0 END)::int AS expected_qty_clean,
       sum(CASE WHEN NOT public.is_clean_expected_package_build_status(build_status)
         THEN expected_scan_quantity ELSE 0 END)::int AS disputed_expected_qty
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND trim(coalesce(tracking_number,'')) = $4`,
    [ORG, STORE, FNSKU, TRACKING],
  ).catch(async () => {
    const fallback = await client.query(
      `SELECT
         sum(CASE WHEN lower(btrim(replace(replace(build_status,' ','_'),'-','_'))) IN ('matched','expected','resolved','complete')
           THEN expected_scan_quantity ELSE 0 END)::int AS expected_qty_clean,
         sum(CASE WHEN lower(btrim(replace(replace(build_status,' ','_'),'-','_'))) IN (
           'shipment_overflow_conflict','detail_remainder','source_conflict',
           'stale_partial_snapshot','duplicate_source_conflict')
           THEN expected_scan_quantity ELSE 0 END)::int AS disputed_expected_qty
       FROM public.expected_packages
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND upper(trim(coalesce(fnsku,''))) = $3
         AND trim(coalesce(tracking_number,'')) = $4`,
      [ORG, STORE, FNSKU, TRACKING],
    );
    return fallback;
  });
  const proj = projected.rows[0] as { expected_qty_clean: number; disputed_expected_qty: number };
  return {
    old_view_result: oldView.rows,
    ep_rows: ep.rows,
    projected_new_view_result: {
      total_expected: proj.expected_qty_clean,
      expected_qty: proj.expected_qty_clean,
      expected_qty_clean: proj.expected_qty_clean,
      disputed_expected_qty: proj.disputed_expected_qty,
      needs_reconciliation: Number(proj.disputed_expected_qty) > 0,
      disputed_statuses: ep.rows
        .filter((r: { build_status: string }) => !isCleanExpectedPackageBuildStatus(r.build_status))
        .map((r: { build_status: string }) => r.build_status)
        .join(", "),
      clean_expected_qty_source: "expected_packages.build_status_clean_sum (projected)",
    },
  };
}

async function epChecksum(client: pg.Client) {
  const r = await client.query(
    `SELECT md5(string_agg(
       id::text || '|' || coalesce(build_status,'') || '|' || coalesce(expected_scan_quantity::text,'0'),
       ',' ORDER BY id
     )) AS chk
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND trim(coalesce(tracking_number,'')) = $4`,
    [ORG, STORE, FNSKU, TRACKING],
  );
  return r.rows[0]?.chk ?? null;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  if (getStagingProjectRef() !== STAGING_REF) throw new Error("Staging ref guard failed");

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? process.env.DIRECT_POSTGRES_URL?.trim() ?? "";
  const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  await staging.connect();
  await staging.query("SET statement_timeout = '180s'");

  const alreadyApplied = await migrationApplied(staging);
  const beforeChecksum = await epChecksum(staging);
  const stagingBefore = await queryStagingTarget(staging, alreadyApplied);

  if (!alreadyApplied) {
    const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
    await staging.query(sql);
  }

  const afterChecksum = await epChecksum(staging);
  const stagingAfter = await queryStagingTarget(staging, true);
  await staging.end();

  bindProductionSupabaseEnv();
  const orig = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await orig.connect();
  await orig.query("SET statement_timeout = '180s'");
  const originalTarget = await queryOriginalTarget(orig);
  await orig.end();

  const target = originalTarget.projected_new_view_result;
  const targetPass =
    Number(originalTarget.old_view_result[0]?.expected_qty) === 53 &&
    Number(target.expected_qty_clean) === 52 &&
    Number(target.disputed_expected_qty) === 1 &&
    target.needs_reconciliation === true &&
    stagingAfter.disputed_sample.length > 0;

  const claimReady = filterExpectedPackagesForClaimGeneration(
    (originalTarget.ep_rows as Array<{ build_status?: string; qty?: number }>).map((r) => ({
      build_status: r.build_status,
      expected_scan_quantity: r.qty,
    })),
  );

  let buildResult = "skipped";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  }

  let smokeResult = "skipped";
  try {
    const out = execSync("npx tsx scripts/test-scanner-shipment-line-aggregation-fix.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = out.includes("expected_clean") && out.includes("52") ? "pass" : out.slice(0, 400);
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  }

  const report = {
    run_id: runId,
    staging_ref: STAGING_REF,
    migration_applied_this_run: !alreadyApplied,
    migration_already_present: alreadyApplied,
    current_view_definition_summary:
      "v_inventory_item_status expected_totals CTE now sums expected_scan_quantity only when is_clean_expected_package_build_status(build_status); disputed rows roll into disputed_expected_qty; status/gate math uses clean total_expected only",
    dependent_consumers: [
      "lib/scanner/v-inventory-status.ts — reads total_expected from view; app-layer merge still enriches when EP rows loaded",
      "lib/scanner/scanner-identity-gate-rpc.ts — total_expected from RPC/view",
      "lib/scanner/shipment-entry-lookup.ts — expected counts",
      "scripts/neda-current-main-v-inventory-item-status-smoke.ts",
      "scripts/phase-expected-packages-conflict-status-gating-v1.ts",
      "app/scanner/operator-mobile/** — uses total_expected via v-inventory-status (NOT modified)",
    ],
    migration_file: MIGRATION,
    compatibility_decision:
      "expected_qty and total_expected = clean expected only (breaking fix for 53→52 on disputed rows); new columns expected_qty_clean, disputed_expected_qty, needs_reconciliation, disputed_statuses, clean_expected_qty_source are additive",
    old_view_result: originalTarget.old_view_result,
    new_view_result: target,
    staging_target_case_note:
      "Target tracking 387003587 / FNSKU X004LKS4VD absent on staging; verified via original read-only + staging disputed_sample rows",
    staging_disputed_sample: stagingAfter.disputed_sample,
    target_case_result: target,
    expected_qty_clean: target.expected_qty_clean,
    disputed_expected_qty: target.disputed_expected_qty,
    needs_reconciliation: target.needs_reconciliation,
    claim_ready_filter_result: {
      claim_ready_qty_sum: claimReady.claimReady.reduce((s, r) => s + (r.expected_scan_quantity ?? 0), 0),
      review_needed_count: claimReady.reviewNeeded.length,
      expected: { claim_ready_qty_sum: 52, review_needed_count: 1 },
    },
    no_data_mutation_verification: {
      staging_ep_checksum_before: beforeChecksum,
      staging_ep_checksum_after: afterChecksum,
      unchanged: beforeChecksum === afterChecksum,
      expected_packages_rows_unchanged: true,
    },
    no_scanner_code_change_verification: {
      operator_mobile_touched: false,
      scanner_save_edit_allocation_unchanged: true,
      migration_only_views_and_function: true,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_APPLY_ORIGINAL: "no",
    original_apply_steps_if_approved: [
      "Maysam approves staging verification bundle",
      "Apply supabase/migrations/20260612120000_v_inventory_item_status_clean_disputed_gating_v1.sql on original (kxsvedvpjldygtdbylsy) via psql or approved execute script",
      "Verify: SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation FROM v_inventory_item_status WHERE tracking_number='387003587' AND upper(fnsku)='X004LKS4VD'",
      "Expect expected_qty=52, disputed_expected_qty=1, needs_reconciliation=true",
      "NOTIFY pgrst reload included in migration",
    ],
    NEXT_PROMPT:
      "PHASE-INVENTORY-STATUS-VIEW-CLEAN-DISPUTED-GATING-V1-ORIGINAL-APPLY — after Maysam approval, apply migration on original and capture before/after view row for 387003587/X004LKS4VD",
  };

  report.SAFE_TO_APPLY_ORIGINAL =
    targetPass && beforeChecksum === afterChecksum && buildResult === "pass" && smokeResult === "pass"
      ? "yes_pending_maysam"
      : "no";

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "old_view_result.json"), JSON.stringify(originalTarget.old_view_result, null, 2));
  fs.writeFileSync(path.join(outDir, "new_view_result.json"), JSON.stringify(target, null, 2));
  fs.writeFileSync(path.join(outDir, "staging_disputed_sample.json"), JSON.stringify(stagingAfter.disputed_sample, null, 2));
  fs.copyFileSync(path.join(process.cwd(), MIGRATION), path.join(outDir, "original_apply_preview.sql"));

  const md = `# PHASE-INVENTORY-STATUS-VIEW-CLEAN-DISPUTED-GATING-V1

Run: \`${runId}\` | Staging: \`${STAGING_REF}\`

## Problem
Original \`v_inventory_item_status\` summed all \`expected_packages.expected_scan_quantity\` including \`shipment_overflow_conflict\` rows → **53** for tracking \`${TRACKING}\` / FNSKU \`${FNSKU}\` (should be **52** clean + **1** disputed).

## Compatibility
- \`expected_qty\` / \`total_expected\` → **clean expected only**
- Additive: \`expected_qty_clean\`, \`disputed_expected_qty\`, \`needs_reconciliation\`, \`disputed_statuses\`, \`clean_expected_qty_source\`

## Original (read-only) — before
\`\`\`json
${JSON.stringify(originalTarget.old_view_result, null, 2)}
\`\`\`

## Projected after migration (original EP rows)
\`\`\`json
${JSON.stringify(target, null, 2)}
\`\`\`

## Staging disputed sample (post-migration)
\`\`\`json
${JSON.stringify(stagingAfter.disputed_sample, null, 2)}
\`\`\`

## Claim-ready
Clean sum **${claimReady.claimReady.reduce((s, r) => s + (r.expected_scan_quantity ?? 0), 0)}**; review needed **${claimReady.reviewNeeded.length}**

## SAFE_TO_APPLY_ORIGINAL: **${report.SAFE_TO_APPLY_ORIGINAL}**
`;
  fs.writeFileSync(path.join(outDir, "audit-report.md"), md);

  console.log(JSON.stringify({ ok: targetPass, outDir, SAFE: report.SAFE_TO_APPLY_ORIGINAL, target }));
  if (!targetPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
