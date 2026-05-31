/**
 * CLAIM-RETURN-LINE-BACKFILL-EXECUTE — governed staging INSERT into claim_lines.
 *
 *   npx tsx scripts/claim-return-line-backfill-execute.ts --execute [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { sqlReturnItemBackfillLaneWhere } from "../lib/return-item-physical-scan";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/claim-return-line-backfill-approval.md";
const DRYRUN_PLAN = ".cursor/audit-reports/claim-return-line-backfill-dryrun/20260528T160000Z/backfill-plan.json";
const OUT_BASE = ".cursor/audit-reports/claim-return-line-backfill-execute";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): { valid: boolean; flags: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const staging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const backfill = /APPROVED_CLAIM_RETURN_LINE_BACKFILL\s*=\s*true/i.test(text);
  return {
    valid: staging && backfill,
    flags: {
      APPROVED_TO_RUN_STAGING: staging ? "true" : "false",
      APPROVED_CLAIM_RETURN_LINE_BACKFILL: backfill ? "true" : "false",
    },
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Backfill approval flags not both true");
  if (!fs.existsSync(path.join(process.cwd(), DRYRUN_PLAN))) {
    blockers.push(`Dry-run plan missing: ${DRYRUN_PLAN}`);
  }

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const rollbackSql = `-- Rollback: claim_lines backfill run ${runId} (staging only)
DELETE FROM public.claim_lines
WHERE metadata->>'backfill_run_id' = '${runId}';
`;

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      ...Object.entries(approval.flags).map(([k, v]) => `- ${k}: **${v}**`),
      "",
      `Dry-run plan: \`${DRYRUN_PLAN}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);

  if (blockers.length || !execute) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      (blockers.length ? blockers : ["Pass --execute to run backfill"]).map((b) => `- ${b}`).join("\n") + "\n",
    );
    const manifest = {
      prompt: "CLAIM-RETURN-LINE-BACKFILL-EXECUTE",
      run_id: runId,
      status: blockers.length ? "BLOCKED" : "DRY_RUN_ONLY",
      blockers,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
    if (blockers.length) process.exit(1);
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const tableOk = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='claim_lines'
     ) AS ok`,
  );
  if (!(tableOk.rows[0] as { ok: boolean }).ok) {
    blockers.push("claim_lines table missing");
    await client.end();
    process.exit(1);
  }

  const beforeR = await client.query(`SELECT COUNT(*)::int AS c FROM public.claim_lines`);
  const countBefore = (beforeR.rows[0] as { c: number }).c;

  const meta = (lane: string) =>
    JSON.stringify({ backfill_run_id: runId, lane, dryrun_run_id: "20260528T160000Z" });

  const laneResults: Record<string, { inserted: number }> = {};

  // 1) return_items
  const riSql = `
    INSERT INTO public.claim_lines (
      organization_id, store_id, return_item_id, expected_package_id,
      resolved_product_id, package_id,
      order_id, sku, fnsku, asin,
      line_grain, discrepancy_kind, quantity_basis, count_basis,
      idempotency_key, status, metadata
    )
    SELECT
      ri.organization_id,
      ri.store_id,
      ri.id,
      ri.expected_item_id,
      ri.resolved_product_id,
      ri.package_id,
      ri.order_id,
      ri.sku,
      ri.fnsku,
      ri.asin,
      'return_item',
      'other',
      'units',
      'scan_count',
      'cl:return_item:' || ri.organization_id::text || ':' || ri.id::text,
      'detected',
      $1::jsonb
    FROM public.return_items ri
    WHERE ${sqlReturnItemBackfillLaneWhere("ri")}
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  const riRes = await client.query(riSql, [meta("return_items_with_expected_item_id")]);
  laneResults.return_items_with_expected_item_id = { inserted: riRes.rowCount ?? 0 };

  // 2) expected_group short
  const shortSql = `
    WITH short_groups AS (
      SELECT v.organization_id, v.store_id, v.tracking_number, v.slip_code, v.sku, v.fnsku,
             v.order_id, v.total_expected, v.total_scanned
      FROM public.v_inventory_item_status v
      WHERE v.total_expected > 0 AND v.total_scanned < v.total_expected
    ),
    root_pick AS (
      SELECT g.*,
             (
               SELECT ep.id
               FROM public.expected_packages ep
               LEFT JOIN LATERAL public.normalize_removal_tracking_operational(ep.tracking_number) tn ON TRUE
               WHERE ep.organization_id = g.organization_id
                 AND (g.store_id IS NULL OR ep.store_id = g.store_id)
                 AND COALESCE(tn.operational, ep.tracking_number) IS NOT DISTINCT FROM g.tracking_number
                 AND ep.id_slip_contents IS NOT DISTINCT FROM g.slip_code
                 AND ep.sku IS NOT DISTINCT FROM g.sku
                 AND ep.fnsku IS NOT DISTINCT FROM g.fnsku
                 AND ep.build_source IN ('detail_shipment', 'detail_remainder', 'legacy')
               ORDER BY ep.created_at
               LIMIT 1
             ) AS root_ep_id
      FROM short_groups g
    )
    INSERT INTO public.claim_lines (
      organization_id, store_id, expected_package_root_id,
      tracking_number, order_id, sku, fnsku,
      line_grain, discrepancy_kind,
      quantity_expected, quantity_actual, quantity_delta,
      quantity_basis, count_basis,
      idempotency_key, status, metadata
    )
    SELECT
      r.organization_id,
      r.store_id,
      r.root_ep_id,
      r.tracking_number,
      r.order_id,
      r.sku,
      r.fnsku,
      'expected_group',
      'short',
      r.total_expected,
      r.total_scanned,
      r.total_expected - r.total_scanned,
      'units',
      'scan_count',
      'cl:expected_group:' || r.organization_id::text || ':' || r.root_ep_id::text || ':short',
      'detected',
      $1::jsonb
    FROM root_pick r
    WHERE r.root_ep_id IS NOT NULL
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  const shortRes = await client.query(shortSql, [meta("expected_group_short")]);
  laneResults.expected_group_short = { inserted: shortRes.rowCount ?? 0 };

  // 3) expected_group overage
  const overSql = `
    WITH over_groups AS (
      SELECT v.organization_id, v.store_id, v.tracking_number, v.slip_code, v.sku, v.fnsku,
             v.order_id, v.total_expected, v.total_scanned
      FROM public.v_inventory_item_status v
      WHERE v.total_expected > 0 AND v.total_scanned > v.total_expected
    ),
    root_pick AS (
      SELECT g.*,
             (
               SELECT ep.id
               FROM public.expected_packages ep
               LEFT JOIN LATERAL public.normalize_removal_tracking_operational(ep.tracking_number) tn ON TRUE
               WHERE ep.organization_id = g.organization_id
                 AND (g.store_id IS NULL OR ep.store_id = g.store_id)
                 AND COALESCE(tn.operational, ep.tracking_number) IS NOT DISTINCT FROM g.tracking_number
                 AND ep.id_slip_contents IS NOT DISTINCT FROM g.slip_code
                 AND ep.sku IS NOT DISTINCT FROM g.sku
                 AND ep.fnsku IS NOT DISTINCT FROM g.fnsku
                 AND ep.build_source IN ('detail_shipment', 'detail_remainder', 'legacy')
               ORDER BY ep.created_at
               LIMIT 1
             ) AS root_ep_id
      FROM over_groups g
    )
    INSERT INTO public.claim_lines (
      organization_id, store_id, expected_package_root_id,
      tracking_number, order_id, sku, fnsku,
      line_grain, discrepancy_kind,
      quantity_expected, quantity_actual, quantity_delta,
      quantity_basis, count_basis,
      idempotency_key, status, metadata
    )
    SELECT
      r.organization_id,
      r.store_id,
      r.root_ep_id,
      r.tracking_number,
      r.order_id,
      r.sku,
      r.fnsku,
      'expected_group',
      'overage',
      r.total_expected,
      r.total_scanned,
      r.total_scanned - r.total_expected,
      'units',
      'scan_count',
      'cl:expected_group:' || r.organization_id::text || ':' || r.root_ep_id::text || ':overage',
      'detected',
      $1::jsonb
    FROM root_pick r
    WHERE r.root_ep_id IS NOT NULL
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  const overRes = await client.query(overSql, [meta("expected_group_overage")]);
  laneResults.expected_group_overage = { inserted: overRes.rowCount ?? 0 };

  // 4) removal claim_candidates
  const removalSql = `
    INSERT INTO public.claim_lines (
      organization_id, store_id, claim_candidate_id,
      resolved_product_id,
      source_table, source_row_id,
      sku, fnsku, asin,
      line_grain, discrepancy_kind,
      idempotency_key, status, metadata
    )
    SELECT DISTINCT ON (cc.organization_id, cc.source_table, cc.source_row_id)
      cc.organization_id,
      cc.store_id,
      cc.id,
      cc.resolved_product_id,
      cc.source_table,
      cc.source_row_id::text,
      cc.sku,
      cc.fnsku,
      cc.asin,
      'import_source',
      'removal_financial',
      'cl:import:' || cc.organization_id::text || ':' || cc.source_table || ':' || cc.source_row_id::text,
      'detected',
      $1::jsonb
    FROM public.claim_candidates cc
    WHERE cc.source_table IN ('amazon_removals', 'amazon_removal_shipments')
    ORDER BY cc.organization_id, cc.source_table, cc.source_row_id, cc.created_at DESC NULLS LAST
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  const removalRes = await client.query(removalSql, [meta("removal_claim_candidates")]);
  laneResults.removal_claim_candidates = { inserted: removalRes.rowCount ?? 0 };

  // 5) returnish claim_candidates (cross-lane skip)
  const returnishSql = `
    INSERT INTO public.claim_lines (
      organization_id, store_id, claim_candidate_id,
      resolved_product_id,
      source_table, source_row_id,
      sku, fnsku, asin,
      line_grain, discrepancy_kind,
      idempotency_key, status, metadata
    )
    SELECT DISTINCT ON (cc.organization_id, cc.source_table, cc.source_row_id)
      cc.organization_id,
      cc.store_id,
      cc.id,
      cc.resolved_product_id,
      cc.source_table,
      cc.source_row_id::text,
      cc.sku,
      cc.fnsku,
      cc.asin,
      'import_source',
      'import_candidate',
      'cl:import:' || cc.organization_id::text || ':' || cc.source_table || ':' || cc.source_row_id::text,
      'detected',
      $1::jsonb
    FROM public.claim_candidates cc
    WHERE cc.source_table IN ('return_items', 'returns', 'amazon_returns')
      AND NOT (
        cc.source_table = 'return_items'
        AND EXISTS (
          SELECT 1 FROM public.return_items ri
          WHERE ri.deleted_at IS NULL
            AND ri.expected_item_id IS NOT NULL
            AND ri.id::text = cc.source_row_id::text
            AND ri.organization_id = cc.organization_id
        )
      )
    ORDER BY cc.organization_id, cc.source_table, cc.source_row_id, cc.created_at DESC NULLS LAST
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  const returnishRes = await client.query(returnishSql, [meta("returnish_claim_candidates")]);
  laneResults.returnish_claim_candidates = { inserted: returnishRes.rowCount ?? 0 };

  const afterR = await client.query(`SELECT COUNT(*)::int AS c FROM public.claim_lines`);
  const countAfter = (afterR.rows[0] as { c: number }).c;
  const insertedTotal = countAfter - countBefore;
  const insertedReturning = Object.values(laneResults).reduce((s, x) => s + x.inserted, 0);

  const taggedR = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.claim_lines WHERE metadata->>'backfill_run_id' = $1`,
    [runId],
  );
  const taggedCount = (taggedR.rows[0] as { c: number }).c;

  await client.end();

  const plan = JSON.parse(fs.readFileSync(path.join(process.cwd(), DRYRUN_PLAN), "utf8")) as {
    estimated_inserts_after_dedupe: number;
  };
  const totalNetInserted = countAfter - countBefore;
  const dedupedSkipped = Math.max(0, plan.estimated_inserts_after_dedupe - countAfter);
  const estimateDelta = countAfter - plan.estimated_inserts_after_dedupe;
  const estimateMismatch = estimateDelta !== 0;

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Execute result",
      "",
      `- **Rows before:** ${countBefore}`,
      `- **Rows after:** ${countAfter}`,
      `- **Net inserted (this run start → end):** ${insertedTotal}`,
      `- **RETURNING inserted (this invocation lanes):** ${insertedReturning}`,
      countBefore > 0 ? `- **Pre-existing rows at run start:** ${countBefore} (idempotent lanes skipped via ON CONFLICT)` : "",
      `- **Tagged with backfill_run_id:** ${taggedCount}`,
      `- **Deduped/skipped (estimate):** ${Math.max(0, dedupedSkipped)}`,
      estimateMismatch
        ? `- **Dry-run delta:** ${estimateDelta} (investigate if non-zero after idempotent retry)`
        : `- **Dry-run estimate:** matched`,
      "",
      "## By lane",
      "",
      ...Object.entries(laneResults).map(([k, v]) => `- \`${k}\`: **${v.inserted}**`),
      "",
      "TRID rows: **not created**",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None") + "\n",
  );

  const nextPrompt = blockers.length
    ? "CLAIM-RETURN-LINE-BACKFILL-EXECUTE-RETRY — reconcile insert delta"
    : "TRID-FOUNDATION-MIGRATION-DRYRUN — TRID schema dry-run after claim_lines backfill";

  const manifest = {
    prompt: "CLAIM-RETURN-LINE-BACKFILL-EXECUTE",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    rows_before: countBefore,
    rows_after: countAfter,
    claim_lines_total: countAfter,
    claim_lines_inserted_this_run: insertedReturning,
    claim_lines_net_inserted: totalNetInserted,
    rows_pre_existing_at_run_start: countBefore,
    deduped_skipped_estimate: dedupedSkipped,
    lane_results: laneResults,
    blockers,
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    next_prompt: nextPrompt,
    estimate_mismatch: estimateMismatch,
    status: blockers.length ? "FAIL" : estimateMismatch ? "PASS_WITH_DELTA" : "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
