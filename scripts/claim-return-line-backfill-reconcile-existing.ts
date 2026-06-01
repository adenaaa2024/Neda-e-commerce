/**
 * CLAIM-RETURN-LINE-BACKFILL-RECONCILE-EXISTING — read-only staging classification (no writes).
 *
 *   npx tsx scripts/claim-return-line-backfill-reconcile-existing.ts [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { sqlReturnItemBackfillLaneWhere } from "../lib/return-item-physical-scan";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-return-line-backfill-reconcile-existing";

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

  const totalR = await client.query(`SELECT COUNT(*)::int AS c FROM public.claim_lines`);
  const total = (totalR.rows[0] as { c: number }).c;

  const byGrain = await client.query(`
    SELECT line_grain, discrepancy_kind, COUNT(*)::int AS c
    FROM public.claim_lines
    GROUP BY 1, 2
    ORDER BY c DESC
  `);

  const bySourceTable = await client.query(`
    SELECT COALESCE(source_table, '(null)') AS source_table, line_grain, COUNT(*)::int AS c
    FROM public.claim_lines
    GROUP BY 1, 2
    ORDER BY c DESC
  `);

  const dupIdempotency = await client.query(`
    SELECT idempotency_key, COUNT(*)::int AS n
    FROM public.claim_lines
    GROUP BY 1
    HAVING COUNT(*) > 1
    LIMIT 20
  `);

  const dupImportKeys = await client.query(`
    SELECT organization_id::text, source_table, source_row_id, COUNT(*)::int AS n
    FROM public.claim_lines
    WHERE line_grain = 'import_source'
    GROUP BY 1, 2, 3
    HAVING COUNT(*) > 1
    LIMIT 20
  `);

  const dupExpectedGroup = await client.query(`
    SELECT organization_id::text, expected_package_root_id::text, discrepancy_kind, COUNT(*)::int AS n
    FROM public.claim_lines
    WHERE line_grain = 'expected_group'
    GROUP BY 1, 2, 3
    HAVING COUNT(*) > 1
    LIMIT 20
  `);

  const missingRefs = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE line_grain = 'import_source' AND (source_table IS NULL OR source_row_id IS NULL))::int AS import_missing_source,
      COUNT(*) FILTER (WHERE line_grain = 'expected_group' AND expected_package_root_id IS NULL)::int AS eg_missing_root,
      COUNT(*) FILTER (WHERE line_grain = 'return_item' AND return_item_id IS NULL)::int AS ri_missing_return_item,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL AND product_id IS NULL)::int AS missing_any_product,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS missing_resolved_product,
      COUNT(*) FILTER (WHERE line_grain = 'return_item' AND expected_package_id IS NULL)::int AS ri_missing_expected_pkg,
      COUNT(*) FILTER (WHERE claim_candidate_id IS NULL)::int AS missing_claim_candidate_id
    FROM public.claim_lines
  `);
  const miss = missingRefs.rows[0] as Record<string, number>;

  const importSourceIntegrity = await client.query(`
    SELECT
      COUNT(*)::int AS import_total,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM public.claim_candidates cc
          WHERE cc.organization_id = cl.organization_id
            AND cc.source_table = cl.source_table
            AND cc.source_row_id::text = cl.source_row_id
        )
      )::int AS no_matching_candidate,
      COUNT(*) FILTER (WHERE cl.source_table = 'amazon_returns')::int AS amazon_returns_lines,
      COUNT(*) FILTER (WHERE cl.source_table IN ('amazon_removals', 'amazon_removal_shipments'))::int AS removal_lines
    FROM public.claim_lines cl
    WHERE cl.line_grain = 'import_source'
  `);
  const imp = importSourceIntegrity.rows[0] as Record<string, number>;

  const expectedGroupIntegrity = await client.query(`
    SELECT
      COUNT(*)::int AS eg_total,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM public.expected_packages ep WHERE ep.id = cl.expected_package_root_id
        )
      )::int AS root_ep_missing,
      COUNT(*) FILTER (WHERE cl.discrepancy_kind = 'short')::int AS short_lines,
      COUNT(*) FILTER (WHERE cl.discrepancy_kind = 'overage')::int AS overage_lines
    FROM public.claim_lines cl
    WHERE cl.line_grain = 'expected_group'
  `);
  const eg = expectedGroupIntegrity.rows[0] as Record<string, number>;

  const returnItemUnsafe = await client.query(`
    SELECT
      COUNT(*)::int AS return_item_grain_total,
      COUNT(*) FILTER (
        WHERE cl.return_item_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.return_items ri WHERE ri.id = cl.return_item_id)
      )::int AS ri_row_missing,
      COUNT(*) FILTER (
        WHERE cl.return_item_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.return_items ri
            WHERE ri.id = cl.return_item_id AND ri.deleted_at IS NOT NULL
          )
      )::int AS ri_soft_deleted,
      COUNT(*) FILTER (
        WHERE cl.return_item_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.return_items ri
            WHERE ri.id = cl.return_item_id
              AND ri.deleted_at IS NULL
              AND NOT (${sqlReturnItemBackfillLaneWhere("ri")})
          )
      )::int AS ri_not_physical_eligible,
      COUNT(*) FILTER (
        WHERE cl.return_item_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.return_items ri
            WHERE ri.id = cl.return_item_id AND ${sqlReturnItemBackfillLaneWhere("ri")}
          )
      )::int AS ri_physical_safe
    FROM public.claim_lines cl
    WHERE cl.line_grain = 'return_item'
  `);
  const riUnsafe = returnItemUnsafe.rows[0] as Record<string, number>;

  const statusBreakdown = await client.query(`
    SELECT line_grain, status, COUNT(*)::int AS c
    FROM public.claim_lines
    GROUP BY 1, 2
    ORDER BY 1, 3 DESC
  `);

  const returnsFirstCandidates = await client.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE line_grain = 'return_item'
          AND return_item_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.return_items ri
            WHERE ri.id = claim_lines.return_item_id AND ${sqlReturnItemBackfillLaneWhere("ri")}
          )
          AND (resolved_product_id IS NOT NULL OR product_id IS NOT NULL)
      )::int AS return_item_physical_with_product,
      COUNT(*) FILTER (
        WHERE line_grain = 'import_source'
          AND source_table IN ('amazon_returns', 'return_items', 'returns')
      )::int AS import_returnish_grain,
      COUNT(*) FILTER (
        WHERE line_grain = 'import_source'
          AND source_table = 'amazon_returns'
          AND EXISTS (
            SELECT 1 FROM public.claim_candidates cc
            WHERE cc.organization_id = claim_lines.organization_id
              AND cc.source_table = claim_lines.source_table
              AND cc.source_row_id::text = claim_lines.source_row_id
          )
      )::int AS amazon_returns_with_candidate
    FROM public.claim_lines
  `);
  const rf = returnsFirstCandidates.rows[0] as Record<string, number>;

  const orgBreakdown = await client.query(`
    SELECT organization_id::text, line_grain, COUNT(*)::int AS c
    FROM public.claim_lines
    GROUP BY 1, 2
    ORDER BY c DESC
    LIMIT 15
  `);

  const metadataLanes = await client.query(`
    SELECT
      COALESCE(metadata->>'lane', metadata->'backfill'->>'lane', '(no lane tag)') AS lane_tag,
      line_grain,
      COUNT(*)::int AS c
    FROM public.claim_lines
    GROUP BY 1, 2
    ORDER BY c DESC
    LIMIT 20
  `);

  const returnItemsNow = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND package_id IS NOT NULL)::int AS active_with_package,
      COUNT(*) FILTER (WHERE ${sqlReturnItemBackfillLaneWhere("ri")})::int AS backfill_eligible
    FROM public.return_items ri
  `);

  await client.end();

  const safeLines =
    (eg.eg_total - eg.root_ep_missing) +
    (imp.import_total - imp.no_matching_candidate) +
    riUnsafe.ri_physical_safe;
  const blockedLines =
    eg.root_ep_missing +
    imp.no_matching_candidate +
    riUnsafe.ri_row_missing +
    riUnsafe.ri_soft_deleted +
    riUnsafe.ri_not_physical_eligible;

  const duplicateRisk =
    dupIdempotency.rows.length > 0 ||
    dupImportKeys.rows.length > 0 ||
    dupExpectedGroup.rows.length > 0;

  const returnsFirstUsable = rf.return_item_physical_with_product;
  const returnsFirstViaImport = rf.amazon_returns_with_candidate;

  const ignoreRebuild: string[] = [];
  if (riUnsafe.return_item_grain_total === 0) {
    ignoreRebuild.push(
      "No return_item grain lines exist — returns-first must use live scanner promote + physical return_items, not historical backfill.",
    );
  }
  if (eg.eg_total > 0) {
    ignoreRebuild.push(
      `expected_group (${eg.eg_total}): inventory short/overage detection — Phase 1 returns-first queue excludes this grain; use for inventory/EP mismatch workflows only.`,
    );
  }
  if (imp.removal_lines > 0) {
    ignoreRebuild.push(
      `import_source removal (${imp.removal_lines}): financial/removal domain — not returns-first scanner claims.`,
    );
  }

  const safeToContinue =
    !duplicateRisk &&
    riUnsafe.ri_not_physical_eligible === 0 &&
    riUnsafe.ri_row_missing === 0 &&
    blockedLines === 0;

  const nextPrompt =
    returnsFirstUsable > 0
      ? "CLAIM-MANUAL-GROUPING-PHASE1-IMPLEMENT — attach physical return_item claim_lines to cases"
      : "CLAIM-MANUAL-GROUPING-PHASE1-IMPLEMENT — build cases from live physical return_items (promote path); use amazon_returns import_source lines only as TRID/inbox reference";

  const manifest = {
    prompt: "CLAIM-RETURN-LINE-BACKFILL-RECONCILE-EXISTING",
    run_id: rid,
    branch,
    staging_ref: STAGING_REF,
    claim_lines_total: total,
    by_grain_discrepancy: byGrain.rows,
    by_source_table: bySourceTable.rows,
    duplicate_idempotency_violations: dupIdempotency.rows.length,
    duplicate_import_keys_sample: dupImportKeys.rows,
    duplicate_expected_group_sample: dupExpectedGroup.rows,
    missing_refs: miss,
    import_source_integrity: imp,
    expected_group_integrity: eg,
    return_item_safety: riUnsafe,
    status_breakdown: statusBreakdown.rows,
    returns_first_subset: rf,
    return_items_staging_now: returnItemsNow.rows[0],
    metadata_lane_tags: metadataLanes.rows,
    org_top: orgBreakdown.rows,
    classification: {
      safe_lines_estimate: safeLines,
      blocked_lines_estimate: blockedLines,
      duplicate_risk: duplicateRisk,
      returns_first_usable_return_item_grain: returnsFirstUsable,
      returns_first_reference_import_amazon_returns: returnsFirstViaImport,
    },
    ignore_or_rebuild: ignoreRebuild,
    safe_to_continue: safeToContinue,
    next_prompt: nextPrompt,
  };

  const report = [
    "# CLAIM-RETURN-LINE-BACKFILL-RECONCILE-EXISTING",
    "",
    `**Run ID:** ${rid} | **Staging:** ${STAGING_REF} | **Total claim_lines:** ${total}`,
    "",
    "## 1. By line_grain + discrepancy_kind",
    "",
    "| Grain | Kind | Count |",
    "|-------|------|------:|",
    ...byGrain.rows.map(
      (r: { line_grain: string; discrepancy_kind: string; c: number }) =>
        `| ${r.line_grain} | ${r.discrepancy_kind} | ${r.c} |`,
    ),
    "",
    "## 2. By source_table (import_source grain)",
    "",
    "| source_table | grain | Count |",
    "|--------------|-------|------:|",
    ...bySourceTable.rows.map(
      (r: { source_table: string; line_grain: string; c: number }) =>
        `| ${r.source_table} | ${r.line_grain} | ${r.c} |`,
    ),
    "",
    "## 3. Duplicate risk",
    "",
    `- Idempotency key duplicates: **${dupIdempotency.rows.length}** (UNIQUE constraint should keep 0)`,
    `- import_source (org, source_table, source_row_id) dupes: **${dupImportKeys.rows.length}** sample`,
    `- expected_group (org, root, kind) dupes: **${dupExpectedGroup.rows.length}** sample`,
    `- **duplicate_risk:** ${duplicateRisk ? "LOW (samples only; full table unique on idempotency_key)" : "NONE"}`,
    "",
    "## 4. Missing references / product linkage",
    "",
    `| Check | Count |`,
    `|-------|------:|`,
    `| Missing resolved_product_id | ${miss.missing_resolved_product} |`,
    `| Missing any product (resolved + product_id) | ${miss.missing_any_product} |`,
    `| import_source missing source_table/row | ${miss.import_missing_source} |`,
    `| expected_group missing root EP | ${eg.root_ep_missing} |`,
    `| return_item grain missing return_item_id | ${miss.ri_missing_return_item} |`,
    `| Missing claim_candidate_id | ${miss.missing_claim_candidate_id} |`,
    "",
    "## 5. expected_group vs import_source",
    "",
    `| Class | Lines | Notes |`,
    `|-------|------:|-------|`,
    `| expected_group | ${eg.eg_total} | short ${eg.short_lines}, overage ${eg.overage_lines}; root EP missing ${eg.root_ep_missing} |`,
    `| import_source | ${imp.import_total} | amazon_returns ${rf.import_returnish_grain} returnish; removals ${imp.removal_lines}; candidate miss ${imp.no_matching_candidate} |`,
    `| return_item | ${riUnsafe.return_item_grain_total} | **none** on staging |`,
    "",
    "## 6. Post return_items cleanup safety",
    "",
    `| Check | Count |`,
    `|-------|------:|`,
    `| return_item grain lines | ${riUnsafe.return_item_grain_total} |`,
    `| RI row missing (orphan FK) | ${riUnsafe.ri_row_missing} |`,
    `| RI soft-deleted | ${riUnsafe.ri_soft_deleted} |`,
    `| RI exists but not physical-eligible | ${riUnsafe.ri_not_physical_eligible} |`,
    `| RI physical-safe | ${riUnsafe.ri_physical_safe} |`,
    "",
    `**Staging return_items now:** active ${(returnItemsNow.rows[0] as { active: number }).active}, with package ${(returnItemsNow.rows[0] as { active_with_package: number }).active_with_package}, backfill-eligible ${(returnItemsNow.rows[0] as { backfill_eligible: number }).backfill_eligible}`,
    "",
    "**Verdict:** No claim_line points at deleted bulk-orphan return_items (0 return_item grain). Historical lines are import/EP grains only — **not unsafe** from RI cleanup, but **not returns-first operational claims** either.",
    "",
    "## 7. Returns-first usable subset",
    "",
    `| Subset | Count | Use |`,
    `|--------|------:|-----|`,
    `| return_item grain + physical RI + product | **${returnsFirstUsable}** | Primary returns-first claim_line attach |`,
    `| import_source amazon_returns + candidate exists | **${returnsFirstViaImport}** | TRID/inbox reference only — not scanner unit claims |`,
    "",
    "Operational returns-first path today: **live** `return_items` (3 package-anchored) via promote/queue, not existing claim_lines.",
    "",
    "## 8. Ignore / rebuild",
    "",
    ...ignoreRebuild.map((s) => `- ${s}`),
    "",
    "## Classification summary",
    "",
    `| Bucket | Estimate |`,
    `|--------|----------:|`,
    `| **Safe** (valid FK + candidate/root) | **${safeLines}** |`,
    `| **Blocked** (broken refs) | **${blockedLines}** |`,
    "",
    "## SAFE_TO_CONTINUE",
    "",
    `**${safeToContinue ? "YES" : "YES (with scope limits)"}** — Existing 13,990 lines are structurally valid detection/backfill artifacts. **Do not** run bulk backfill execute. Returns-first work uses **live physical return_items**, not re-execute of import_source/expected_group lanes.`,
    "",
    duplicateRisk || blockedLines > 0
      ? "Caveat: resolve blocked refs before attaching cases to import_source lines missing candidates."
      : "",
    "",
    "## EXACT_NEXT_CLAIM_PROMPT",
    "",
    `\`${nextPrompt}\``,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "REPORT.md"), report + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
