/**
 * PHASE-DEPLOY-ORIGINAL-VERIFY-POST-PUSH-SNAPSHOT-V1 (read-only)
 *   npx tsx scripts/phase-deploy-original-verify-post-push-snapshot-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const OUT_BASE = ".cursor/audit-reports/phase-deploy-original-verify-post-push-snapshot-v1";

const BASELINE = {
  amazon_removals: 3520,
  amazon_removal_shipments: 11517,
  stuck_removal_uploads: 0,
  expected_packages: 12109,
  claim_candidates: 9055,
  expected_qty_clean: 52,
  disputed_expected_qty: 1,
  needs_reconciliation: true,
};

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const removals = (
    await client.query(
      `SELECT count(*)::int AS row_count,
              max(created_at)::text AS max_created_at,
              max(coalesce(shipment_date, request_date))::text AS max_event_date
       FROM public.amazon_removals
       WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
      [ORG, STORE],
    )
  ).rows[0];

  const shipments = (
    await client.query(
      `SELECT count(*)::int AS row_count,
              max(created_at)::text AS max_created_at,
              max(shipment_date)::text AS max_event_date
       FROM public.amazon_removal_shipments
       WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
      [ORG, STORE],
    )
  ).rows[0];

  const stuckUploads = await client.query(
    `SELECT report_type, count(*)::int AS stuck_count
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'source_run'->>'state' = 'synthetic_upload_ready'
     GROUP BY report_type`,
    [ORG],
  );
  const stuckTotal = (stuckUploads.rows as { stuck_count: number }[]).reduce((s, r) => s + r.stuck_count, 0);

  const ep = (
    await client.query(
      `SELECT count(*)::int AS row_count, max(updated_at)::text AS max_updated_at
       FROM public.expected_packages
       WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
      [ORG, STORE],
    )
  ).rows[0];

  const viewRows = await client.query(
    `SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation,
            disputed_statuses, total_expected, total_scanned, status
     FROM public.v_inventory_item_status
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(coalesce(tracking_number,'')) = $3
       AND upper(trim(coalesce(fnsku,''))) = $4`,
    [ORG, STORE, TRACKING, FNSKU],
  );
  const viewRow = viewRows.rows[0] as Record<string, unknown> | undefined;

  const claimCandidates = (
    await client.query(`SELECT count(*)::int AS row_count FROM public.claim_candidates WHERE organization_id = $1::uuid`, [
      ORG,
    ])
  ).rows[0];

  const rlsReimb = await client.query(`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('amazon_reimbursements', 'claim_reimbursements')
    ORDER BY c.relname
  `);

  const rlsPolicies = await client.query(`
    SELECT tablename, policyname, roles, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('amazon_reimbursements', 'claim_reimbursements')
    ORDER BY tablename, policyname
  `);

  await client.end();

  const viewPass =
    viewRow != null &&
    Number(viewRow.expected_qty_clean) === BASELINE.expected_qty_clean &&
    Number(viewRow.disputed_expected_qty) === BASELINE.disputed_expected_qty &&
    viewRow.needs_reconciliation === BASELINE.needs_reconciliation;

  let scannerSmoke: Record<string, unknown> = { mode: "read_only_module" };
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    require.cache[require.resolve("server-only")] = {
      id: "server-only",
      filename: "server-only",
      loaded: true,
      exports: {},
    } as NodeModule;
    const {
      resolveInventoryExpectedClean,
      resolveInventoryDisputedQuantity,
    } = await import("../lib/scanner/v-inventory-status");
    if (viewRow) {
      const rowLike = {
        expected_qty: viewRow.expected_qty,
        expected_qty_clean: viewRow.expected_qty_clean,
        disputed_expected_qty: viewRow.disputed_expected_qty,
        disputed_quantity: Number(viewRow.disputed_expected_qty ?? 0),
        needs_reconciliation: viewRow.needs_reconciliation,
        total_expected: viewRow.total_expected,
        total_scanned: viewRow.total_scanned,
      };
      scannerSmoke = {
        mode: "read_only_module",
        resolveInventoryExpectedClean: resolveInventoryExpectedClean(rowLike as never),
        resolveInventoryDisputedQuantity: resolveInventoryDisputedQuantity(rowLike as never),
        pass:
          resolveInventoryExpectedClean(rowLike as never) === BASELINE.expected_qty_clean &&
          resolveInventoryDisputedQuantity(rowLike as never) === BASELINE.disputed_expected_qty,
      };
    }
  } catch (e) {
    scannerSmoke = { pass: false, error: e instanceof Error ? e.message : String(e) };
  }

  const removalOk =
    Number(removals?.row_count) === BASELINE.amazon_removals &&
    Number(shipments?.row_count) === BASELINE.amazon_removal_shipments &&
    stuckTotal === BASELINE.stuck_removal_uploads;

  const epOk = Number(ep?.row_count) === BASELINE.expected_packages;
  const claimOk = Number(claimCandidates?.row_count) === BASELINE.claim_candidates;

  const rlsOk = (rlsReimb.rows as Array<{ table_name: string; rls_enabled: boolean; policy_count: number }>).every(
    (r) => r.rls_enabled && r.policy_count >= 2,
  );

  const noRegression = removalOk && epOk && viewPass && claimOk && stuckTotal === 0;

  const report = {
    run_id: runId,
    db: PRODUCTION_REF,
    mode: "read_only_post_push",
    baseline: BASELINE,
    original_snapshot: {
      org_id: ORG,
      store_id: STORE,
      captured_at: runId,
    },
    removal_counts: { amazon_removals: removals, amazon_removal_shipments: shipments },
    stuck_upload_count: { by_type: stuckUploads.rows, total: stuckTotal },
    expected_packages_status: ep,
    target_view_result: {
      tracking: TRACKING,
      fnsku: FNSKU,
      row: viewRow ?? null,
      pass: viewPass,
    },
    claim_candidates_count: Number(claimCandidates?.row_count ?? 0),
    RLS_reimbursement_status: {
      tables: rlsReimb.rows,
      policies: rlsPolicies.rows,
      pass: rlsOk,
    },
    scanner_readonly_smoke: scannerSmoke,
    no_regression_verdict: noRegression ? "PASS" : "FAIL",
    checks: {
      removals: removalOk,
      expected_packages: epOk,
      target_view: viewPass,
      claim_candidates: claimOk,
      stuck_uploads: stuckTotal === 0,
      rls_reimbursements: rlsOk,
    },
    SAFE_TO_CONTINUE_TO_CLAIM_DRYRUN: noRegression && rlsOk ? "yes" : "no",
    NEXT_PROMPT: noRegression
      ? "PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1"
      : "PHASE-DEPLOY-ORIGINAL-REGRESSION-INVESTIGATE-V1",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-report.md"),
    `# Post-push original snapshot

DB: \`${PRODUCTION_REF}\` · Verdict: **${report.no_regression_verdict}**

| Check | Expected | Actual | OK |
|-------|----------|--------|-----|
| amazon_removals | ${BASELINE.amazon_removals} | ${removals?.row_count} | ${Number(removals?.row_count) === BASELINE.amazon_removals} |
| amazon_removal_shipments | ${BASELINE.amazon_removal_shipments} | ${shipments?.row_count} | ${Number(shipments?.row_count) === BASELINE.amazon_removal_shipments} |
| stuck uploads | 0 | ${stuckTotal} | ${stuckTotal === 0} |
| expected_packages | ${BASELINE.expected_packages} | ${ep?.row_count} | ${epOk} |
| view clean/disputed | 52/1 | ${viewRow?.expected_qty_clean}/${viewRow?.disputed_expected_qty} | ${viewPass} |
| claim_candidates | ${BASELINE.claim_candidates} | ${claimCandidates?.row_count} | ${claimOk} |

**SAFE_TO_CONTINUE_TO_CLAIM_DRYRUN:** ${report.SAFE_TO_CONTINUE_TO_CLAIM_DRYRUN}
`,
  );

  console.log(
    JSON.stringify({
      ok: true,
      outDir,
      verdict: report.no_regression_verdict,
      SAFE: report.SAFE_TO_CONTINUE_TO_CLAIM_DRYRUN,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
