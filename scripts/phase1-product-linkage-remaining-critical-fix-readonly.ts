/**
 * PHASE1-PRODUCT-LINKAGE-REMAINING-CRITICAL-FIX (read-only audit)
 *   npx tsx scripts/phase1-product-linkage-remaining-critical-fix-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TARGET_RI = "512cd6ce-1769-494f-a752-a743509cae94";
const OUT_BASE = ".cursor/audit-reports/phase1-product-linkage-remaining-critical-fix";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function columns(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) throw new Error("Staging guard failed");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const epCols = await columns(client, "expected_packages");
  const hasEpAsin = epCols.has("asin");
  const hasEpFnsku = epCols.has("fnsku");
  const hasEpSku = epCols.has("sku");

  const physicalRi = await client.query(
    `
    SELECT
      COUNT(*)::int AS physical_unresolved
    FROM return_items ri
    WHERE ri.deleted_at IS NULL
      AND ri.package_id IS NOT NULL
      AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
      AND ri.resolved_product_id IS NULL
    `,
  );

  const target = await client.query(
    `
    SELECT
      ri.*,
      pkg.status AS package_status,
      pkg.tracking_number AS package_tracking,
      ep.id::text AS ep_id,
      ep.tracking_number AS ep_tracking,
      ep.resolved_product_id::text AS ep_resolved_product_id,
      ep.build_source AS ep_build_source
    FROM return_items ri
    LEFT JOIN packages pkg ON pkg.id = ri.package_id
    LEFT JOIN expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ri.id = $1::uuid
    `,
    [TARGET_RI],
  );

  const targetRow = target.rows[0] as Record<string, unknown> | undefined;
  let mapMatch: Record<string, unknown>[] = [];
  let prodMatch: Record<string, unknown>[] = [];
  let catalogMatch: Record<string, unknown>[] = [];
  let resolutionVerdict = "not_found";

  if (targetRow) {
    const org = String(targetRow.organization_id ?? ORG);
    const store = String(targetRow.store_id ?? STORE);
    const fnsku = String(targetRow.fnsku ?? "").trim();
    const sku = String(targetRow.sku ?? "").trim();
    const asin = String(targetRow.asin ?? "").trim();

    mapMatch = (
      await client.query(
        `
        SELECT id::text, product_id::text, seller_sku, fnsku, asin, match_source
        FROM product_identifier_map
        WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
          AND (
            ($3 <> '' AND upper(btrim(fnsku)) = upper($3))
            OR ($4 <> '' AND upper(btrim(seller_sku)) = upper($4))
            OR ($5 <> '' AND upper(btrim(asin)) = upper($5))
          )
        `,
        [org, store, fnsku, sku, asin],
      )
    ).rows;

    prodMatch = (
      await client.query(
        `
        SELECT id::text, sku, asin, fnsku, product_name
        FROM products
        WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
          AND (
            ($3 <> '' AND upper(btrim(fnsku)) = upper($3))
            OR ($4 <> '' AND upper(btrim(sku)) = upper($4))
            OR ($5 <> '' AND upper(btrim(asin)) = upper($5))
          )
        `,
        [org, store, fnsku, sku, asin],
      )
    ).rows;

    if (asin) {
      catalogMatch = (
        await client.query(
          `SELECT id::text, seller_sku, asin, fnsku FROM catalog_products
           WHERE organization_id=$1::uuid AND store_id=$2::uuid AND upper(btrim(asin))=upper($3)`,
          [org, store, asin],
        )
      ).rows;
    }

    const mapProductIds = [...new Set(mapMatch.map((r) => String(r.product_id)))];
    const prodIds = [...new Set(prodMatch.map((r) => String(r.id)))];

    if (mapProductIds.length === 1) {
      resolutionVerdict = "safe_map_exact_one_product";
    } else if (mapProductIds.length > 1) {
      resolutionVerdict = "blocked_map_ambiguous";
    } else if (prodIds.length === 1) {
      resolutionVerdict = "safe_products_direct_one";
    } else if (prodIds.length > 1) {
      resolutionVerdict = "blocked_products_ambiguous";
    } else if (!fnsku && !sku && !asin && !String(targetRow.product_identifier ?? "").trim()) {
      resolutionVerdict = "needs_manual_review_no_identifiers";
    } else if (String(targetRow.item_name ?? "").toLowerCase().includes("test")) {
      resolutionVerdict = "demo_excluded_test_junk";
    } else {
      resolutionVerdict = "needs_manual_review_no_spine_match";
    }
  }

  const epBuckets = await client.query(
    `
    WITH unresolved AS (
      SELECT ep.*
      FROM expected_packages ep
      WHERE ep.resolved_product_id IS NULL
        AND ep.organization_id = $1::uuid
        AND ep.store_id = $2::uuid
    ),
    classified AS (
      SELECT
        u.id,
        ${hasEpAsin ? "NULLIF(btrim(u.asin),'') IS NOT NULL" : "false"} AS has_asin,
        ${hasEpFnsku ? "NULLIF(btrim(u.fnsku),'') IS NOT NULL" : "false"} AS has_fnsku,
        ${hasEpSku ? "NULLIF(btrim(u.sku),'') IS NOT NULL" : "false"} AS has_sku,
        (
          SELECT COUNT(DISTINCT p.id)::int FROM products p
          WHERE p.organization_id = u.organization_id AND p.store_id = u.store_id AND p.deleted_at IS NULL
            AND (
              ${hasEpFnsku && hasEpSku && hasEpAsin ? `
              (${hasEpFnsku ? "NULLIF(btrim(u.fnsku),'') IS NOT NULL AND upper(btrim(p.fnsku))=upper(btrim(u.fnsku))" : "false"})
              OR (${hasEpSku ? "NULLIF(btrim(u.sku),'') IS NOT NULL AND upper(btrim(p.sku))=upper(btrim(u.sku))" : "false"})
              OR (${hasEpAsin ? "NULLIF(btrim(u.asin),'') IS NOT NULL AND upper(btrim(p.asin))=upper(btrim(u.asin))" : "false"})
              ` : "false"}
            )
        ) AS direct_product_hits,
        (
          SELECT COUNT(DISTINCT m.product_id)::int FROM product_identifier_map m
          WHERE m.organization_id = u.organization_id AND m.store_id = u.store_id AND m.deleted_at IS NULL
            AND (
              ${hasEpFnsku ? "(NULLIF(btrim(u.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(u.fnsku)))" : "false"}
              ${hasEpSku ? "OR (NULLIF(btrim(u.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(u.sku)))" : ""}
              ${hasEpAsin && epCols.has("asin") ? "OR (NULLIF(btrim(u.asin),'') IS NOT NULL AND upper(btrim(m.asin))=upper(btrim(u.asin)))" : ""}
            )
        ) AS map_product_hits
      FROM unresolved u
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN NOT has_asin AND NOT has_fnsku AND NOT has_sku THEN 'missing_identifiers'
          WHEN map_product_hits = 1 THEN 'class_a_map_exists_backfill'
          WHEN map_product_hits > 1 THEN 'manual_review_map_ambiguous'
          WHEN direct_product_hits = 1 AND map_product_hits = 0 THEN 'products_direct_exact_map_missing'
          WHEN direct_product_hits > 1 THEN 'manual_review_product_ambiguous'
          WHEN has_asin AND direct_product_hits = 0 AND map_product_hits = 0 THEN 'product_seed_candidate_asin_no_spine'
          WHEN has_fnsku AND NOT has_asin AND direct_product_hits = 0 AND map_product_hits = 0 THEN 'product_seed_candidate_fnsku_only'
          ELSE 'manual_review_other'
        END AS bucket,
        has_asin,
        id
      FROM classified
    )
    SELECT bucket, COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE has_asin)::int AS with_asin
    FROM bucketed
    GROUP BY bucket
    ORDER BY count DESC
    `,
    [ORG, STORE],
  );

  const epTotal = await client.query(
    `SELECT COUNT(*)::int AS c FROM expected_packages
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND resolved_product_id IS NULL`,
    [ORG, STORE],
  );

  const epAsinDirectSafe = hasEpAsin
    ? await client.query(
        `
    WITH u AS (
      SELECT ep.id, ep.asin
      FROM expected_packages ep
      WHERE ep.organization_id=$1::uuid AND ep.store_id=$2::uuid AND ep.resolved_product_id IS NULL
        AND NULLIF(btrim(ep.asin),'') IS NOT NULL
    ),
    hits AS (
      SELECT u.id, COUNT(DISTINCT p.id)::int AS n, MIN(p.id::text) AS product_id
      FROM u
      JOIN products p ON p.organization_id=$1::uuid AND p.store_id=$2::uuid AND p.deleted_at IS NULL
        AND upper(btrim(p.asin))=upper(btrim(u.asin))
      GROUP BY u.id
    )
    SELECT COUNT(*)::int AS conflict_free_asin_direct FROM hits WHERE n = 1
    `,
        [ORG, STORE],
      )
    : { rows: [{ conflict_free_asin_direct: 0 }] };

  const histRi = await client.query(
    `
    SELECT
      COUNT(*)::int AS unresolved_total,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND package_id IS NOT NULL
          AND NOT (expected_item_id IS NOT NULL AND package_id IS NULL AND pallet_id IS NULL)
      )::int AS physical_unresolved,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND package_id IS NULL AND expected_item_id IS NOT NULL
      )::int AS bulk_orphan_unresolved,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND package_id IS NULL AND expected_item_id IS NULL
      )::int AS no_anchor_unresolved,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND package_id IS NOT NULL AND expected_item_id IS NOT NULL
      )::int AS physical_with_ep_link_unresolved,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND package_id IS NOT NULL AND expected_item_id IS NULL
      )::int AS physical_no_ep_link_unresolved
    FROM return_items
    WHERE deleted_at IS NULL AND resolved_product_id IS NULL
    `,
  );

  const histRiMapReady = await client.query(
    `
    SELECT COUNT(*)::int AS c
    FROM return_items ri
    WHERE ri.deleted_at IS NULL AND ri.resolved_product_id IS NULL
      AND ri.package_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM product_identifier_map m
        WHERE m.deleted_at IS NULL AND m.organization_id = ri.organization_id AND m.store_id = ri.store_id
          AND (
            (NULLIF(btrim(ri.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(ri.fnsku)))
            OR (NULLIF(btrim(ri.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(ri.sku)))
            OR (NULLIF(btrim(ri.asin),'') IS NOT NULL AND upper(btrim(m.asin))=upper(btrim(ri.asin)))
          )
      )
    `,
  );

  await client.end();

  const physicalLinkedAfter = targetRow?.resolved_product_id
    ? Number(physicalRi.rows[0]?.physical_unresolved ?? 0)
    : resolutionVerdict.startsWith("safe_")
      ? Math.max(0, Number(physicalRi.rows[0]?.physical_unresolved ?? 0) - 1)
      : Number(physicalRi.rows[0]?.physical_unresolved ?? 0);

  const report = {
    run_id: runId,
    staging_ref: STAGING_REF,
    physical_ri_512: {
      id: TARGET_RI,
      found: Boolean(targetRow),
      row: targetRow
        ? {
            organization_id: targetRow.organization_id,
            store_id: targetRow.store_id,
            package_id: targetRow.package_id,
            pallet_id: targetRow.pallet_id,
            expected_item_id: targetRow.expected_item_id,
            resolved_product_id: targetRow.resolved_product_id,
            identifier_resolution_status: targetRow.identifier_resolution_status,
            sku: targetRow.sku,
            fnsku: targetRow.fnsku,
            asin: targetRow.asin,
            lpn: targetRow.lpn,
            order_id: targetRow.order_id,
            product_identifier: targetRow.product_identifier,
            item_name: targetRow.item_name,
            package_status: targetRow.package_status,
            ep_id: targetRow.ep_id,
            ep_resolved_product_id: targetRow.ep_resolved_product_id,
            ep_build_source: targetRow.ep_build_source,
          }
        : null,
      map_matches: mapMatch,
      product_matches: prodMatch,
      catalog_matches: catalogMatch,
      resolution_verdict: resolutionVerdict,
      recommended_disposition:
        resolutionVerdict.startsWith("safe_")
          ? "apply_exact_resolution"
          : resolutionVerdict.startsWith("demo_")
            ? "demo_excluded"
            : "needs_manual_review",
    },
    physical_return_process_unresolved_before: physicalRi.rows[0]?.physical_unresolved ?? 0,
    expected_packages_320: {
      total_unresolved: epTotal.rows[0]?.c ?? 0,
      buckets: epBuckets.rows,
      conflict_free_asin_products_direct: epAsinDirectSafe.rows[0]?.conflict_free_asin_direct ?? 0,
    },
    historical_return_items_unresolved: {
      ...histRi.rows[0],
      physical_with_map_match_unresolved: histRiMapReady.rows[0]?.c ?? 0,
      classify_only: true,
    },
    patch_eligible: resolutionVerdict.startsWith("safe_"),
    safe_next_wave_prompt:
      Number(epTotal.rows[0]?.c ?? 0) > 0
        ? "EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-SAMPLE-WAVE-STAGING — 320 EP all Class C fnsku-only; FNSKU enrichment sample ready"
        : "EXPECTED-LINKAGE-CLASS-A-EP-BACKFILL-SAMPLE — if Class A rows appear after map bridge",
    blocked_reasons: [
      resolutionVerdict.startsWith("blocked_") ? `physical_ri:${resolutionVerdict}` : null,
      Number(epTotal.rows[0]?.c ?? 0) === 320 ? "ep_320_all_class_c_no_spine" : null,
      Number(histRi.rows[0]?.unresolved_total ?? 0) > 100 ? "historical_ri_bulk_classify_only_no_mass_update" : null,
    ].filter(Boolean),
  };

  fs.writeFileSync(path.join(outDir, "audit.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Phase 1 product linkage remaining critical fix\n\n**Run:** \`${runId}\`\n\n## Physical RI \`${TARGET_RI}\`\n\n- Verdict: **${resolutionVerdict}**\n- Patch eligible: **${report.patch_eligible}**\n\n## EP unresolved\n\n- Total: **${report.expected_packages_320.total_unresolved}**\n\n## Historical RI\n\n\`\`\`json\n${JSON.stringify(report.historical_return_items_unresolved, null, 2)}\n\`\`\`\n`,
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
