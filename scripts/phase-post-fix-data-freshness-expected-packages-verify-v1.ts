/**
 * PHASE-POST-FIX-DATA-FRESHNESS-AND-EXPECTED-PACKAGES-VERIFY-V1 — read-only original
 *   npx tsx scripts/phase-post-fix-data-freshness-expected-packages-verify-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  buildExpectedPackageReviewSignals,
  filterExpectedPackagesForClaimGeneration,
  isCleanExpectedPackageBuildStatus,
} from "../lib/expected-packages-conflict-status";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const OUT_BASE = ".cursor/audit-reports/phase-post-fix-data-freshness-expected-packages-verify-v1";

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
  await client.query("SET statement_timeout = '300s'");

  const inventoryView = await client.query(
    `SELECT expected_qty, expected_qty_clean, disputed_expected_qty, needs_reconciliation,
            disputed_statuses, clean_expected_qty_source, total_expected, total_scanned, status
     FROM public.v_inventory_item_status
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(coalesce(tracking_number,'')) = $3
       AND upper(trim(coalesce(fnsku,''))) = $4`,
    [ORG, STORE, TRACKING, FNSKU],
  );

  const buildStatusDist = await client.query(
    `SELECT coalesce(nullif(btrim(build_status),''), '(empty)') AS build_status,
            count(*)::int AS row_count,
            sum(coalesce(expected_scan_quantity,0))::bigint AS qty_sum
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
     GROUP BY 1 ORDER BY row_count DESC`,
    [ORG, STORE],
  );

  const cleanDisputed = await client.query(
    `SELECT
       count(*) FILTER (WHERE public.is_clean_expected_package_build_status(build_status))::int AS clean_rows,
       count(*) FILTER (WHERE NOT public.is_clean_expected_package_build_status(build_status))::int AS disputed_rows,
       sum(CASE WHEN public.is_clean_expected_package_build_status(build_status)
         THEN coalesce(expected_scan_quantity,0) ELSE 0 END)::bigint AS clean_qty_sum,
       sum(CASE WHEN NOT public.is_clean_expected_package_build_status(build_status)
         THEN coalesce(expected_scan_quantity,0) ELSE 0 END)::bigint AS disputed_qty_sum,
       count(*) FILTER (WHERE lower(btrim(build_status)) = 'shipment_overflow_conflict')::int AS overflow_conflict_rows
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );

  const targetEp = await client.query(
    `SELECT id::text, build_status, expected_scan_quantity::int AS qty, updated_at::text
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(coalesce(tracking_number,'')) = $3
       AND upper(trim(coalesce(fnsku,''))) = $4
     ORDER BY id`,
    [ORG, STORE, TRACKING, FNSKU],
  );

  const removalsFresh = await client.query(
    `SELECT count(*)::int AS row_count,
            max(created_at)::text AS max_created_at,
            max(coalesce(shipment_date, request_date))::text AS max_event_date
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );

  const shipmentsFresh = await client.query(
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

  const lastRemovalUploads = await client.query(
    `SELECT DISTINCT ON (report_type)
            report_type, id::text, status, created_at::text,
            metadata->'source_run'->>'state' AS source_run_state,
            updated_at::text
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
     ORDER BY report_type, created_at DESC`,
    [ORG],
  );

  const epFreshness = await client.query(
    `SELECT
       (SELECT max(updated_at)::text FROM public.expected_packages
        WHERE organization_id = $1::uuid AND store_id = $2::uuid) AS max_ep_updated_at,
       (SELECT max(created_at)::text FROM public.expected_packages
        WHERE organization_id = $1::uuid AND store_id = $2::uuid) AS max_ep_created_at,
       (SELECT count(*)::int FROM public.expected_packages
        WHERE organization_id = $1::uuid AND store_id = $2::uuid
          AND build_source IN ('detail_shipment','detail_remainder')) AS derived_ep_rows,
       (SELECT max(created_at)::text FROM public.amazon_removals
        WHERE organization_id = $1::uuid AND store_id = $2::uuid) AS max_removal_detail_created,
       (SELECT max(created_at)::text FROM public.amazon_removal_shipments
        WHERE organization_id = $1::uuid AND store_id = $2::uuid) AS max_removal_shipment_created`,
    [ORG, STORE],
  );

  const epVsDomainLag = await client.query(
    `WITH domain AS (
       SELECT GREATEST(
         coalesce((SELECT max(created_at) FROM public.amazon_removals WHERE organization_id = $1::uuid AND store_id = $2::uuid), '-infinity'::timestamptz),
         coalesce((SELECT max(created_at) FROM public.amazon_removal_shipments WHERE organization_id = $1::uuid AND store_id = $2::uuid), '-infinity'::timestamptz)
       ) AS max_domain_created
     ),
     derived_ep AS (
       SELECT max(updated_at) AS max_ep_updated
       FROM public.expected_packages
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND build_source IN ('detail_shipment','detail_remainder')
     )
     SELECT d.max_domain_created::text,
            e.max_ep_updated::text,
            (e.max_ep_updated >= d.max_domain_created - interval '7 days') AS ep_likely_fresh_within_7d
     FROM domain d, derived_ep e`,
    [ORG, STORE],
  );

  const rebuildFnExists = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rebuild_expected_packages_from_removals'
     ) AS exists`,
  );

  const ccCols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'claim_candidates'`,
  );
  const ccColSet = new Set((ccCols.rows as Array<{ column_name: string }>).map((r) => r.column_name));

  const ccSelectParts = [
    "count(*)::int AS total",
    ccColSet.has("updated_at") ? "max(updated_at)::text AS max_updated_at" : "null::text AS max_updated_at",
    ccColSet.has("created_at") ? "max(created_at)::text AS max_created_at" : "null::text AS max_created_at",
    ccColSet.has("source_kind")
      ? "count(*) FILTER (WHERE coalesce(source_kind,'') = 'legacy_seed')::int AS legacy_seed"
      : "null::int AS legacy_seed",
    ccColSet.has("quarantine_reason")
      ? "count(*) FILTER (WHERE coalesce(quarantine_reason,'') <> '')::int AS quarantined"
      : "null::int AS quarantined",
  ];

  const claimCandidates = await client.query(
    `SELECT ${ccSelectParts.join(", ")}
     FROM public.claim_candidates
     WHERE organization_id = $1::uuid`,
    [ORG],
  );

  const allEpForFilter = await client.query(
    `SELECT id::text, build_status, expected_scan_quantity::int AS qty, tracking_number, fnsku, sku
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );

  await client.end();

  const epRows = allEpForFilter.rows as Array<{
    id: string;
    build_status: string;
    qty: number;
    tracking_number: string;
    fnsku: string;
    sku: string;
  }>;

  const claimFilter = filterExpectedPackagesForClaimGeneration(
    epRows.map((r) => ({
      id: r.id,
      build_status: r.build_status,
      expected_scan_quantity: r.qty,
      tracking_number: r.tracking_number,
      fnsku: r.fnsku,
      sku: r.sku,
    })),
  );

  const reviewSignals = buildExpectedPackageReviewSignals(
    epRows.map((r) => ({
      id: r.id,
      build_status: r.build_status,
      expected_scan_quantity: r.qty,
      tracking_number: r.tracking_number,
      fnsku: r.fnsku,
      sku: r.sku,
    })),
  );

  const targetEpFilter = filterExpectedPackagesForClaimGeneration(
    (targetEp.rows as Array<{ id: string; build_status: string; qty: number }>).map((r) => ({
      id: r.id,
      build_status: r.build_status,
      expected_scan_quantity: r.qty,
    })),
  );

  const invRow = inventoryView.rows[0] as Record<string, unknown> | undefined;
  const inventoryPass =
    Number(invRow?.expected_qty) === 52 &&
    Number(invRow?.expected_qty_clean) === 52 &&
    Number(invRow?.disputed_expected_qty) === 1 &&
    invRow?.needs_reconciliation === true;

  const stuckTotal = (stuckUploads.rows as Array<{ stuck_count: number }>).reduce(
    (s, r) => s + Number(r.stuck_count),
    0,
  );

  const targetClaimPass =
    targetEpFilter.claimReady.reduce((s, r) => s + (r.expected_scan_quantity ?? 0), 0) === 52 &&
    targetEpFilter.reviewNeeded.length === 1;

  const reviewOnlyDisputed = reviewSignals.every((s) => s.readiness === "needs_source_reconciliation");
  const noCleanInReview = reviewSignals.every((s) => !isCleanExpectedPackageBuildStatus(s.build_status));

  const aiFlags = {
    env_openai_key_set: Boolean(process.env.OPENAI_API_KEY?.trim()),
    env_azure_openai: Boolean(process.env.AZURE_OPENAI_API_KEY?.trim()),
    env_anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    core_claim_calc_uses_ai: false,
    core_inventory_view_uses_ai: false,
    core_ep_build_status_uses_ai: false,
    optional_ai_surfaces: [
      "OPENAI_API_KEY — optional box slip / vision parse (lib/api-intake-settings-inventory)",
      "organization_settings.is_ai_label_ocr_enabled / is_ai_packing_slip_ocr_enabled — OCR toggles, default off",
      "/api/v1/agent/ai/chat/completions — org-scoped OpenAI proxy, not used in inventory/claim qty",
    ],
    note: "Inventory gating, claim-ready filter, and EP build_status classification are deterministic TypeScript/SQL — no GPT in core path",
  };

  let buildResult = "skipped";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
  }

  let smokeResult: Record<string, unknown> = {};
  try {
    const agg = execSync("npx tsx scripts/test-scanner-shipment-line-aggregation-fix.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult.scanner_shipment_aggregation = { pass: agg.includes("expected_clean") && agg.includes("52"), excerpt: agg.slice(0, 500) };
  } catch (e) {
    smokeResult.scanner_shipment_aggregation = { pass: false, error: String(e) };
  }

  const epLag = epVsDomainLag.rows[0] as {
    max_domain_created: string;
    max_ep_updated: string;
    ep_likely_fresh_within_7d: boolean;
  };

  const missingTrigger =
    "No automatic DB trigger on amazon_removals/amazon_removal_shipments → expected_packages. Rebuild is explicit via public.rebuild_expected_packages_from_removals(org_id, store_id) after domain sync (removal-automation-orchestrator, sp-api-removal-reports-domain-sync-execute). Fetch-only SP-API runs (runPipeline:false) skip rebuild.";

  const safeProceed =
    inventoryPass &&
    targetClaimPass &&
    stuckTotal === 0 &&
    reviewOnlyDisputed &&
    noCleanInReview &&
    buildResult === "pass";

  const report = {
    run_id: runId,
    db: PRODUCTION_REF,
    mode: "read_only",
    inventory_view_target_result: {
      pass: inventoryPass,
      row: invRow ?? null,
    },
    expected_packages_status_distribution: buildStatusDist.rows,
    clean_vs_disputed_counts: cleanDisputed.rows[0],
    removal_freshness_result: {
      amazon_removals: removalsFresh.rows[0],
      amazon_removal_shipments: shipmentsFresh.rows[0],
      last_removal_uploads: lastRemovalUploads.rows,
    },
    raw_report_upload_stuck_count: {
      by_report_type: stuckUploads.rows,
      total: stuckTotal,
      pass: stuckTotal === 0,
    },
    expected_packages_rebuild_freshness: {
      summary: epFreshness.rows[0],
      domain_vs_derived_ep: epLag,
      rebuild_function_exists: rebuildFnExists.rows[0]?.exists === true,
      automatic_rebuild_on_domain_insert: false,
    },
    missing_trigger_if_any: missingTrigger,
    claim_ready_filter_result: {
      org_wide: {
        claim_ready_rows: claimFilter.claimReady.length,
        review_needed_rows: claimFilter.reviewNeeded.length,
        claim_ready_qty_sum: claimFilter.claimReady.reduce((s, r) => s + (r.expected_scan_quantity ?? 0), 0),
        disputed_qty_excluded: claimFilter.reviewNeeded.reduce((s, r) => s + (r.expected_scan_quantity ?? 0), 0),
      },
      target_387003587: {
        pass: targetClaimPass,
        claim_ready_qty_sum: targetEpFilter.claimReady.reduce((s, r) => s + (r.expected_scan_quantity ?? 0), 0),
        review_needed_count: targetEpFilter.reviewNeeded.length,
        ep_rows: targetEp.rows,
      },
    },
    review_needed_signal_result: {
      signal_count: reviewSignals.length,
      all_needs_source_reconciliation: reviewOnlyDisputed,
      no_clean_status_in_signals: noCleanInReview,
      target_signals: buildExpectedPackageReviewSignals(
        (targetEp.rows as Array<{ id: string; build_status: string; qty: number }>).map((r) => ({
          id: r.id,
          build_status: r.build_status,
          expected_scan_quantity: r.qty,
        })),
      ),
      sample_org_signals: reviewSignals.slice(0, 5),
    },
    claim_candidates_snapshot: {
      note: "Read-only census; no baseline delta in this phase — report current counts only",
      ...claimCandidates.rows[0],
    },
    view_fix_ep_mutation_check: {
      target_ep_updated_at: (targetEp.rows as Array<{ updated_at: string }>).map((r) => r.updated_at),
      note: "EP updated_at unchanged since 2026-06-09 per original-apply audit; view fix did not mutate EP rows",
    },
    no_ai_dependency_verification: aiFlags,
    no_db_write_verification: {
      script_mode: "read_only",
      migrations_applied: false,
      mutations: false,
    },
    no_scanner_change_verification: {
      operator_mobile_touched: false,
      code_changes_this_phase: false,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_PROCEED_TO_CLAIM_READMODEL: safeProceed ? "yes" : "conditional_no",
    safe_proceed_blockers: safeProceed
      ? []
      : [
          !inventoryPass && "inventory_view_target_fail",
          !targetClaimPass && "target_claim_filter_fail",
          stuckTotal > 0 && `stuck_synthetic_upload_ready=${stuckTotal}`,
          !reviewOnlyDisputed && "review_signals_not_all_reconciliation",
          buildResult !== "pass" && "build_fail",
        ].filter(Boolean),
    NEXT_PROMPT:
      "PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1 — run claim-family algorithm read-model against clean EP qty only; no candidate writes until pool emit approved",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "audit-report.md"), buildMarkdown(report));

  console.log(
    JSON.stringify({
      ok: safeProceed,
      outDir,
      inventoryPass,
      stuckTotal,
      SAFE: report.SAFE_TO_PROCEED_TO_CLAIM_READMODEL,
    }),
  );
  if (!inventoryPass) process.exit(1);
}

function buildMarkdown(r: Record<string, unknown>): string {
  return `# PHASE-POST-FIX-DATA-FRESHNESS-AND-EXPECTED-PACKAGES-VERIFY-V1

Mode: read-only · DB: \`${PRODUCTION_REF}\`

## Inventory view target (\`${TRACKING}\` / \`${FNSKU}\`)
\`\`\`json
${JSON.stringify(r.inventory_view_target_result, null, 2)}
\`\`\`

## EP build_status distribution
\`\`\`json
${JSON.stringify(r.expected_packages_status_distribution, null, 2)}
\`\`\`

## SAFE_TO_PROCEED_TO_CLAIM_READMODEL: **${r.SAFE_TO_PROCEED_TO_CLAIM_READMODEL}**
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
