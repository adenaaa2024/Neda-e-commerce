/**
 * RETURN-PROCESS-PRODUCT-LINKAGE-AUDIT — staging read-only census.
 *   npx tsx scripts/return-process-product-linkage-audit-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/return-process-product-linkage-audit-and-fix";
const MAX_MAP_SAMPLES = 25;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type BucketRow = { bucket: string; count: number };

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) {
    throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging ref");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const ri = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL
          AND package_id IS NOT NULL
          AND NOT (expected_item_id IS NOT NULL AND package_id IS NULL AND pallet_id IS NULL)
      )::int AS physical_return_process,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL
          AND (
            NULLIF(BTRIM(asin), '') IS NOT NULL
            OR NULLIF(BTRIM(fnsku), '') IS NOT NULL
            OR NULLIF(BTRIM(sku), '') IS NOT NULL
            OR NULLIF(BTRIM(product_identifier), '') IS NOT NULL
            OR NULLIF(BTRIM(order_id), '') IS NOT NULL
            OR NULLIF(BTRIM(lpn), '') IS NOT NULL
          )
      )::int AS with_any_identifier,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND NULLIF(BTRIM(resolved_product_id::text), '') IS NOT NULL
      )::int AS with_resolved_product_id,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND NULLIF(BTRIM(resolved_catalog_product_id::text), '') IS NOT NULL
      )::int AS with_resolved_catalog_product_id,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL
          AND LOWER(BTRIM(COALESCE(identifier_resolution_status, ''))) IN ('resolved', 'matched')
      )::int AS status_resolved_or_matched,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL
          AND NULLIF(BTRIM(resolved_product_id::text), '') IS NOT NULL
          AND (
            NULLIF(BTRIM(asin), '') IS NOT NULL
            OR NULLIF(BTRIM(fnsku), '') IS NOT NULL
            OR NULLIF(BTRIM(sku), '') IS NOT NULL
          )
      )::int AS linked_with_identifier
    FROM return_items
  `);

  const gap = await client.query(`
    SELECT
      COUNT(*)::int AS missing_link_has_identifier
    FROM return_items ri
    WHERE ri.deleted_at IS NULL
      AND NULLIF(BTRIM(ri.resolved_product_id::text), '') IS NULL
      AND (
        NULLIF(BTRIM(ri.asin), '') IS NOT NULL
        OR NULLIF(BTRIM(ri.fnsku), '') IS NOT NULL
        OR NULLIF(BTRIM(ri.sku), '') IS NOT NULL
        OR NULLIF(BTRIM(ri.product_identifier), '') IS NOT NULL
      )
  `);

  const statusBuckets = await client.query<BucketRow>(`
    SELECT
      COALESCE(NULLIF(LOWER(BTRIM(identifier_resolution_status)), ''), '(null)') AS bucket,
      COUNT(*)::int AS count
    FROM return_items
    WHERE deleted_at IS NULL
    GROUP BY 1
    ORDER BY count DESC
  `);

  const rootCauseBuckets = await client.query<BucketRow>(`
    SELECT bucket, COUNT(*)::int AS count
    FROM (
      SELECT
        CASE
          WHEN NULLIF(BTRIM(resolved_product_id::text), '') IS NOT NULL
            AND LOWER(BTRIM(COALESCE(identifier_resolution_status, ''))) = 'matched'
            THEN 'ui_matched_status_mislabeled_unresolved'
          WHEN NULLIF(BTRIM(resolved_product_id::text), '') IS NOT NULL
            AND LOWER(BTRIM(COALESCE(identifier_resolution_status, ''))) = 'resolved'
            THEN 'linked_resolved_ok'
          WHEN NULLIF(BTRIM(resolved_product_id::text), '') IS NOT NULL
            THEN 'linked_other_status'
          WHEN NULLIF(BTRIM(asin), '') IS NULL
            AND NULLIF(BTRIM(fnsku), '') IS NULL
            AND NULLIF(BTRIM(sku), '') IS NULL
            AND NULLIF(BTRIM(product_identifier), '') IS NULL
            THEN 'no_identifiers'
          WHEN NOT EXISTS (
            SELECT 1 FROM product_identifier_map pim
            WHERE pim.deleted_at IS NULL
              AND pim.organization_id = ri.organization_id
              AND pim.store_id = ri.store_id
              AND (
                (NULLIF(BTRIM(ri.fnsku), '') IS NOT NULL AND UPPER(BTRIM(pim.fnsku)) = UPPER(BTRIM(ri.fnsku)))
                OR (NULLIF(BTRIM(ri.sku), '') IS NOT NULL AND UPPER(BTRIM(pim.seller_sku)) = UPPER(BTRIM(ri.sku)))
                OR (NULLIF(BTRIM(ri.asin), '') IS NOT NULL AND UPPER(BTRIM(pim.asin)) = UPPER(BTRIM(ri.asin)))
              )
          ) THEN 'map_missing_scoped'
          ELSE 'resolver_or_store_scope_gap'
        END AS bucket
      FROM return_items ri
      WHERE ri.deleted_at IS NULL
        AND ri.package_id IS NOT NULL
    ) sub
    GROUP BY 1
    ORDER BY count DESC
  `);

  const mapCandidates = await client.query(`
    SELECT
      ri.id::text AS return_item_id,
      ri.organization_id::text,
      ri.store_id::text,
      ri.fnsku,
      ri.sku,
      ri.asin,
      ri.item_name,
      ri.identifier_resolution_status
    FROM return_items ri
    WHERE ri.deleted_at IS NULL
      AND ri.package_id IS NOT NULL
      AND NULLIF(BTRIM(ri.resolved_product_id::text), '') IS NULL
      AND (
        NULLIF(BTRIM(ri.fnsku), '') IS NOT NULL
        OR NULLIF(BTRIM(ri.sku), '') IS NOT NULL
        OR NULLIF(BTRIM(ri.asin), '') IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM product_identifier_map pim
        WHERE pim.deleted_at IS NULL
          AND pim.organization_id = ri.organization_id
          AND pim.store_id = ri.store_id
          AND (
            (NULLIF(BTRIM(ri.fnsku), '') IS NOT NULL AND UPPER(BTRIM(pim.fnsku)) = UPPER(BTRIM(ri.fnsku)))
            OR (NULLIF(BTRIM(ri.sku), '') IS NOT NULL AND UPPER(BTRIM(pim.seller_sku)) = UPPER(BTRIM(ri.sku)))
            OR (NULLIF(BTRIM(ri.asin), '') IS NOT NULL AND UPPER(BTRIM(pim.asin)) = UPPER(BTRIM(ri.asin)))
          )
      )
    ORDER BY ri.updated_at DESC NULLS LAST
    LIMIT $1
  `, [MAX_MAP_SAMPLES]);

  const importSource = await client.query(`
    SELECT COUNT(*)::int AS claim_lines_import_source
    FROM claim_lines
    WHERE line_grain = 'import_source'
  `);

  await client.end();

  const counts = {
    return_items: ri.rows[0],
    missing_link_has_identifier: gap.rows[0]?.missing_link_has_identifier ?? 0,
    status_buckets: statusBuckets.rows,
    root_cause_buckets: rootCauseBuckets.rows,
    claim_lines_import_source: importSource.rows[0]?.claim_lines_import_source ?? 0,
  };

  const report = {
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read-only",
    tables_and_views: {
      operational: ["return_items", "packages", "pallets", "slip_contents"],
      views: ["v_inventory_item_status", "v_scanned_items_counted"],
      claims: ["claim_lines (return_item | import_source | expected_group)", "claim_cases"],
      ui: [
        "app/returns/page.tsx (ItemsDataTable)",
        "components/returns/ReturnItemProductLinkage.tsx",
        "app/returns/claims/ReturnsClaimsWorkQueueClient.tsx",
        "app/returns/product-input-lookup-actions.ts",
      ],
      enrich: [
        "lib/product-linkage-display-enrich.ts",
        "lib/scanner/resolve-product-for-scanner-item.ts",
        "product_identifier_map",
      ],
    },
    counts,
    map_candidates_sample: mapCandidates.rows,
    blocked_rows_note:
      "Rows with map match but unresolved rpid require governed backfill (max 25 sample only); no auto-apply.",
  };

  fs.writeFileSync(path.join(outDir, "census.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Return process product linkage audit\n\n**Run:** \`${runId}\`\n\n## Counts\n\n\`\`\`json\n${JSON.stringify(counts, null, 2)}\n\`\`\`\n`,
  );
  console.log(JSON.stringify({ run_id: runId, outDir, counts }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
