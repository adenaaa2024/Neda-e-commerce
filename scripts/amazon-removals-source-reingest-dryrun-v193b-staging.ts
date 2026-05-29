/**
 * AMAZON-REMOVALS-SOURCE-REINGEST-DRYRUN-V193B — investigate broken claim_candidates source_row_id (read-only).
 *
 *   npx tsx scripts/amazon-removals-source-reingest-dryrun-v193b-staging.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/amazon-removals-source-reingest-dryrun-v193b";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (ref=${ref})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const broken = await client.query(`
    SELECT c.id::text, c.organization_id::text, c.store_id::text, c.source_row_id::text,
           c.sku, c.fnsku, c.asin, c.resolved_product_id::text
    FROM public.claim_candidates c
    WHERE c.source_table = 'amazon_removals'
      AND c.resolved_product_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.amazon_removals r
        WHERE r.id = c.source_row_id::uuid AND r.organization_id = c.organization_id
      )
  `);

  const diagnosis = await client.query(`
    WITH broken AS (
      SELECT c.*
      FROM public.claim_candidates c
      WHERE c.source_table = 'amazon_removals'
        AND c.resolved_product_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.amazon_removals r
          WHERE r.id = c.source_row_id::uuid AND r.organization_id = c.organization_id
        )
    )
    SELECT
      COUNT(*)::bigint AS broken_total,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.amazon_removals r WHERE r.id = broken.source_row_id::uuid
      ))::bigint AS id_exists_wrong_org,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.amazon_removal_shipments s WHERE s.id = broken.source_row_id::uuid
      ))::bigint AS id_is_shipment_not_removal,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.amazon_returns ar WHERE ar.id = broken.source_row_id::uuid
      ))::bigint AS id_is_return_not_removal,
      COUNT(*) FILTER (WHERE broken.source_row_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::bigint AS invalid_uuid_format,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.amazon_removals r
        WHERE r.organization_id = broken.organization_id
          AND r.sku IS NOT DISTINCT FROM broken.sku
          AND (broken.fnsku IS NULL OR r.fnsku IS NOT DISTINCT FROM broken.fnsku)
      ))::bigint AS sku_fnsku_rematch_possible
    FROM broken
  `);

  const uploadOverlap = await client.query(`
    WITH broken AS (
      SELECT c.id, c.organization_id, c.source_row_id, c.sku, c.fnsku
      FROM public.claim_candidates c
      WHERE c.source_table = 'amazon_removals'
        AND c.resolved_product_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.amazon_removals r
          WHERE r.id = c.source_row_id::uuid AND r.organization_id = c.organization_id
        )
    )
    SELECT COUNT(DISTINCT b.id)::bigint AS candidates_with_sku_match
    FROM broken b
    INNER JOIN public.amazon_removals r ON r.organization_id = b.organization_id AND r.sku = b.sku
  `);

  const liveRemovals = await client.query(`SELECT COUNT(*)::bigint AS n FROM public.amazon_removals`);
  const liveIds = await client.query(`
    SELECT COUNT(DISTINCT c.source_row_id)::bigint AS distinct_broken_ids
    FROM public.claim_candidates c
    WHERE c.source_table = 'amazon_removals' AND c.resolved_product_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.amazon_removals r
        WHERE r.id = c.source_row_id::uuid AND r.organization_id = c.organization_id
      )
  `);

  const sampleRepairs: Array<Record<string, unknown>> = [];
  for (const row of (broken.rows as Record<string, string>[]).slice(0, 30)) {
    const skuMatch = await client.query(
      `SELECT id::text, order_id, sku, fnsku FROM public.amazon_removals
       WHERE organization_id = $1::uuid AND sku = $2 LIMIT 3`,
      [row.organization_id, row.sku],
    );
    const shipmentHit = await client.query(
      `SELECT id::text FROM public.amazon_removal_shipments WHERE id = $1::uuid LIMIT 1`,
      [row.source_row_id],
    );
    sampleRepairs.push({
      claim_candidate_id: row.id,
      broken_source_row_id: row.source_row_id,
      sku: row.sku,
      fnsku: row.fnsku,
      id_points_to_shipment: (shipmentHit.rowCount ?? 0) > 0,
      sku_rematch_candidates: skuMatch.rows,
      proposed_action:
        (shipmentHit.rowCount ?? 0) > 0
          ? "wrong_source_table_or_stale_id_reingest"
          : skuMatch.rows.length === 1
            ? "dry_run_repoint_source_row_id"
            : skuMatch.rows.length > 1
              ? "manual_review_ambiguous_sku"
              : "import_reingest_or_archive_candidate",
    });
  }

  await client.end();

  const d = diagnosis.rows[0] as Record<string, string>;
  const manifest = {
    prompt: "AMAZON-REMOVALS-SOURCE-REINGEST-DRYRUN-V193B",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "dry_run_only",
    broken_candidates: broken.rows.length,
    live_amazon_removals_rows: Number(liveRemovals.rows[0]?.n ?? 0),
    distinct_broken_source_row_ids: Number(liveIds.rows[0]?.distinct_broken_ids ?? 0),
    diagnosis: d,
    candidates_with_any_sku_match_on_removals: Number(uploadOverlap.rows[0]?.candidates_with_sku_match ?? 0),
    root_cause_summary:
      Number(d.id_is_shipment_not_removal) > 0
        ? "Many source_row_id values point at amazon_removal_shipments IDs, not amazon_removals"
        : Number(d.id_exists_wrong_org) > 0
          ? "IDs exist in amazon_removals under different org scope"
          : "Stale UUIDs from prior import generation — full re-ingest or repoint required",
    execute_eligible: false,
    applied: 0,
    status: "PASS",
    next_prompt: "AMAZON-REMOVALS-SOURCE-REINGEST-PLAN-V194B",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "diagnosis.json"), JSON.stringify(d, null, 2));
  fs.writeFileSync(path.join(outDir, "sample-repair-proposals.json"), JSON.stringify(sampleRepairs, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# AMAZON-REMOVALS-SOURCE-REINGEST-DRYRUN-V193B",
      "",
      `- run_id: \`${runId}\``,
      `- broken claim_candidates (amazon_removals, no live row): **${broken.rows.length}**`,
      `- live amazon_removals rows: **${liveRemovals.rows[0]?.n}**`,
      "",
      "## Diagnosis",
      `- id exists (wrong org): **${d.id_exists_wrong_org}**`,
      `- id is shipment row (wrong table): **${d.id_is_shipment_not_removal}**`,
      `- id is return row: **${d.id_is_return_not_removal}**`,
      `- invalid UUID format: **${d.invalid_uuid_format}**`,
      `- SKU/FNSKU rematch possible: **${d.sku_fnsku_rematch_possible}**`,
      "",
      `**Root cause:** ${manifest.root_cause_summary}`,
      "",
      "No claim table writes. Re-ingest or governed repoint requires operator approval.",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
