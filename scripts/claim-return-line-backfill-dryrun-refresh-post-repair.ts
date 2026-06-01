/**
 * CLAIM-RETURN-LINE-BACKFILL-DRYRUN-REFRESH-POST-REPAIR — read-only staging census (no writes).
 *
 *   npx tsx scripts/claim-return-line-backfill-dryrun-refresh-post-repair.ts [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  BULK_ORPHAN_RETURN_ITEM_PREDICATE_SQL,
  sqlReturnItemBackfillLaneWhere,
} from "../lib/return-item-physical-scan";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-return-line-backfill-dryrun-refresh-post-repair";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const ri = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND package_id IS NOT NULL)::int AS active_with_package,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL)::int AS active_with_expected_item_id,
      COUNT(*) FILTER (WHERE ${sqlReturnItemBackfillLaneWhere("ri")})::int AS backfill_lane_eligible,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL
          AND expected_item_id IS NOT NULL
          AND NOT (${sqlReturnItemBackfillLaneWhere("ri")})
      )::int AS expected_only_blocked,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND (${BULK_ORPHAN_RETURN_ITEM_PREDICATE_SQL}))::int AS bulk_orphan_active
    FROM public.return_items ri
  `);
  const riRow = ri.rows[0] as Record<string, number>;

  const claimLinesTotal = await client.query(`SELECT COUNT(*)::int AS c FROM public.claim_lines`);
  const claimLinesByGrain = await client.query(`
    SELECT line_grain, COUNT(*)::int AS c
    FROM public.claim_lines
    GROUP BY 1
    ORDER BY c DESC
  `);
  const claimLinesReturnItem = await client.query(`
    SELECT
      COUNT(*)::int AS total_return_item_grain,
      COUNT(*) FILTER (WHERE return_item_id IS NOT NULL)::int AS with_return_item_id,
      COUNT(*) FILTER (
        WHERE return_item_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.return_items ri WHERE ri.id = claim_lines.return_item_id
          )
      )::int AS ri_still_exists,
      COUNT(*) FILTER (
        WHERE return_item_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.return_items ri
            WHERE ri.id = claim_lines.return_item_id AND ${sqlReturnItemBackfillLaneWhere("ri")}
          )
      )::int AS ri_physical_eligible_now
    FROM public.claim_lines
    WHERE line_grain = 'return_item'
  `);
  const claimLinesImportSource = await client.query(`
    SELECT source_table, COUNT(*)::int AS c
    FROM public.claim_lines
    WHERE line_grain = 'import_source'
    GROUP BY 1
    ORDER BY c DESC
    LIMIT 20
  `);

  const ccRemoval = await client.query(`
    SELECT COUNT(*)::int AS raw,
           COUNT(DISTINCT organization_id::text || '|' || source_table || '|' || source_row_id)::int AS distinct_keys
    FROM public.claim_candidates
    WHERE source_table IN ('amazon_removals', 'amazon_removal_shipments')
  `);
  const ccReturnish = await client.query(`
    SELECT COUNT(*)::int AS raw,
           COUNT(DISTINCT organization_id::text || '|' || source_table || '|' || source_row_id)::int AS distinct_keys
    FROM public.claim_candidates
    WHERE source_table IN ('return_items', 'returns', 'amazon_returns')
  `);
  const crossReturnItemWins = await client.query(`
    SELECT COUNT(*)::int AS c
    FROM public.claim_candidates cc
    WHERE cc.source_table = 'return_items'
      AND EXISTS (
        SELECT 1 FROM public.return_items ri
        WHERE ${sqlReturnItemBackfillLaneWhere("ri")}
          AND ri.id::text = cc.source_row_id::text
          AND ri.organization_id = cc.organization_id
      )
  `);

  let invShort = 0;
  let invOver = 0;
  let invResolvableShort = 0;
  let invResolvableOver = 0;
  const invExists =
    (await client.query(
      `SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='v_inventory_item_status'`,
    )).rowCount ?? 0;
  if (invExists > 0) {
    const inv = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE total_expected > 0 AND total_scanned < total_expected)::int AS short_groups,
        COUNT(*) FILTER (WHERE total_expected > 0 AND total_scanned > total_expected)::int AS overage_groups
      FROM public.v_inventory_item_status
    `);
    invShort = (inv.rows[0] as { short_groups: number }).short_groups;
    invOver = (inv.rows[0] as { overage_groups: number }).overage_groups;

    const resolvable = await client.query(`
      WITH short_groups AS (
        SELECT v.organization_id, v.store_id, v.tracking_number, v.slip_code, v.sku, v.fnsku,
               'short'::text AS discrepancy_kind
        FROM public.v_inventory_item_status v
        WHERE v.total_expected > 0 AND v.total_scanned < v.total_expected
      ),
      over_groups AS (
        SELECT v.organization_id, v.store_id, v.tracking_number, v.slip_code, v.sku, v.fnsku,
               'overage'::text AS discrepancy_kind
        FROM public.v_inventory_item_status v
        WHERE v.total_expected > 0 AND v.total_scanned > v.total_expected
      ),
      groups AS (SELECT * FROM short_groups UNION ALL SELECT * FROM over_groups),
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
        FROM groups g
      )
      SELECT
        COUNT(*) FILTER (WHERE discrepancy_kind = 'short' AND root_ep_id IS NOT NULL)::int AS short_resolvable,
        COUNT(*) FILTER (WHERE discrepancy_kind = 'overage' AND root_ep_id IS NOT NULL)::int AS over_resolvable
      FROM root_pick
    `);
    invResolvableShort = (resolvable.rows[0] as { short_resolvable: number }).short_resolvable;
    invResolvableOver = (resolvable.rows[0] as { over_resolvable: number }).over_resolvable;
  }

  await client.end();

  const remD = ccRemoval.rows[0] as { raw: number; distinct_keys: number };
  const retD = ccReturnish.rows[0] as { raw: number; distinct_keys: number };
  const crossSkip = Number((crossReturnItemWins.rows[0] as { c: number }).c ?? 0);
  const returnItemLaneInserts = riRow.backfill_lane_eligible;
  const removalInsert = remD.distinct_keys;
  const returnishInsert = Math.max(0, retD.distinct_keys - crossSkip);
  const expectedShortInsert = invResolvableShort;
  const expectedOverInsert = invResolvableOver;
  const estimatedNewInserts =
    returnItemLaneInserts + removalInsert + returnishInsert + expectedShortInsert + expectedOverInsert;

  const claimLinesTotalN = (claimLinesTotal.rows[0] as { c: number }).c;
  const clRi = claimLinesReturnItem.rows[0] as Record<string, number>;

  const executeBlockers: string[] = [];
  if (claimLinesTotalN > 0) {
    executeBlockers.push(
      `claim_lines already has ${claimLinesTotalN} rows — governed backfill execute is NOT idempotent re-run; reconcile or new lane policy required`,
    );
  }
  if (riRow.bulk_orphan_active > 0) {
    executeBlockers.push(`${riRow.bulk_orphan_active} active bulk-orphan return_items remain`);
  }
  const safeToExecute = executeBlockers.length === 0 && estimatedNewInserts > 0;

  const lanes = {
    return_items_with_expected_item_id: {
      planned_inserts: returnItemLaneInserts,
      physical_anchor_eligible: riRow.backfill_lane_eligible,
      expected_only_blocked: riRow.expected_only_blocked,
      line_grain: "return_item",
    },
    expected_group_short: { planned_inserts: expectedShortInsert, line_grain: "expected_group" },
    expected_group_overage: { planned_inserts: expectedOverInsert, line_grain: "expected_group" },
    removal_claim_candidates: { planned_inserts: removalInsert, line_grain: "import_source" },
    returnish_claim_candidates: {
      planned_inserts: returnishInsert,
      cross_lane_skipped: crossSkip,
      line_grain: "import_source",
    },
  };

  const manifest = {
    prompt: "CLAIM-RETURN-LINE-BACKFILL-DRYRUN-REFRESH-POST-REPAIR",
    run_id: rid,
    branch,
    staging_ref: STAGING_REF,
    return_items: riRow,
    claim_lines_total: claimLinesTotalN,
    claim_lines_by_grain: claimLinesByGrain.rows,
    claim_lines_return_item_detail: clRi,
    claim_lines_import_source_top: claimLinesImportSource.rows,
    lanes,
    estimated_new_inserts_if_empty_table: estimatedNewInserts,
    execute_blockers: executeBlockers,
    safe_to_execute: safeToExecute,
    next_prompt: safeToExecute
      ? "CLAIM-RETURN-LINE-BACKFILL-EXECUTE — only after explicit operator approval"
      : "CLAIM-RETURN-LINE-BACKFILL-RECONCILE-EXISTING — classify 13k+ lines; do not blind execute",
  };

  const report = [
    "# CLAIM-RETURN-LINE-BACKFILL-DRYRUN-REFRESH-POST-REPAIR",
    "",
    `**Run ID:** ${rid}`,
    `**Branch:** ${branch}`,
    `**Staging:** ${STAGING_REF}`,
    "",
    "## return_items (post-repair)",
    "",
    `| Metric | Count |`,
    `|--------|------:|`,
    `| Total | ${riRow.total} |`,
    `| Active | ${riRow.active} |`,
    `| Active with package_id | ${riRow.active_with_package} |`,
    `| Active with expected_item_id | ${riRow.active_with_expected_item_id} |`,
    `| **Backfill lane eligible (physical)** | **${riRow.backfill_lane_eligible}** |`,
    `| Expected-only blocked (not physical) | ${riRow.expected_only_blocked} |`,
    `| Bulk orphan active (should be 0) | ${riRow.bulk_orphan_active} |`,
    "",
    "## Lane planned inserts (ON CONFLICT DO NOTHING — net new if keys absent)",
    "",
    `| Lane | Planned |`,
    `|------|--------:|`,
    `| return_item (physical) | ${returnItemLaneInserts} |`,
    `| expected_group short | ${expectedShortInsert} |`,
    `| expected_group overage | ${expectedOverInsert} |`,
    `| removal import_source | ${removalInsert} |`,
    `| returnish import_source | ${returnishInsert} |`,
    `| **Estimated total new keys** | **${estimatedNewInserts}** |`,
    "",
    "## Existing claim_lines",
    "",
    `**Total:** ${claimLinesTotalN}`,
    "",
    "### By line_grain",
    "",
    ...claimLinesByGrain.rows.map(
      (r: { line_grain: string; c: number }) => `- \`${r.line_grain}\`: **${r.c}**`,
    ),
    "",
    "### return_item grain detail",
    "",
    `- Rows: **${clRi.total_return_item_grain}**`,
    `- With return_item_id: **${clRi.with_return_item_id}**`,
    `- Linked RI still exists: **${clRi.ri_still_exists}**`,
    `- Would pass physical gate today: **${clRi.ri_physical_eligible_now}**`,
    "",
    ...(claimLinesImportSource.rows.length
      ? [
          "### import_source top source_table",
          "",
          ...claimLinesImportSource.rows.map(
            (r: { source_table: string | null; c: number }) =>
              `- \`${r.source_table ?? "(null)"}\`: **${r.c}**`,
          ),
          "",
        ]
      : []),
    "## Physical anchor confirmation",
    "",
    "- return_item backfill lane SQL: `sqlReturnItemBackfillLaneWhere` (package_id required, bulk orphan excluded)",
    `- Expected-only rows blocked from return_item lane: **${riRow.expected_only_blocked}**`,
    "- expected_group lanes use `expected_packages` root EP — not return_item grain",
    "",
    `## SAFE_TO_EXECUTE: **${safeToExecute ? "YES" : "NO"}**`,
    "",
    ...(executeBlockers.length
      ? ["**Blockers:**", "", ...executeBlockers.map((b) => `- ${b}`), ""]
      : ["No hard execute blockers beyond operator approval.", ""]),
    "",
    "## NEXT_CLAIM_PROMPT",
    "",
    `\`${manifest.next_prompt}\``,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "REPORT.md"), report + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
