/**
 * EXPECTED-PACKAGES-E2-PRODUCT-PROMOTION-EXECUTE-V194
 *
 * Governed staging-only product + product_identifier_map promotion for
 * expected_packages rows with exact trusted imported source evidence.
 *
 * No expected_packages updates. No Amazon API. No production/original.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/expected-packages-e2-product-promotion-execute-v194";
const E2_APPROVAL = ".cursor/operator-approvals/expected-packages-e2-product-promotion-v194-approval.md";
const API_APPROVAL = ".cursor/operator-approvals/expected-packages-amazon-api-enrichment-v194-approval.md";
const MATCH_SOURCE = "expected_packages_e2_product_promotion_v194";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function approvalTrue(file: string, flags: string[]): boolean {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return flags.every((f) => new RegExp(`${f}\\s*=\\s*true`, "i").test(text));
}

function apiApprovalState(): { approved: boolean; note: string } {
  const p = path.join(process.cwd(), API_APPROVAL);
  if (!fs.existsSync(p)) return { approved: false, note: "approval_file_missing" };
  const text = fs.readFileSync(p, "utf8");
  const run = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const api = /APPROVED_EXPECTED_PACKAGES_AMAZON_API_ENRICHMENT_V194\s*=\s*true/i.test(text);
  return {
    approved: run && api,
    note: run && !api ? "api_flag_not_true_check_spelling" : run && api ? "approved" : "not_approved",
  };
}

async function coverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id, NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id=ep.organization_id
       AND m.store_id=ep.store_id
       AND m.deleted_at IS NULL
       AND ep.fnsku IS NOT NULL
       AND m.fnsku=ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id=ep.organization_id
       AND m.store_id=ep.store_id
       AND m.deleted_at IS NULL
       AND ep.sku IS NOT NULL
       AND (m.seller_sku=ep.sku OR m.msku=ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'direct_resolved'
          WHEN COALESCE(mf.product_count,0)=1 THEN 'map_fnsku'
          WHEN COALESCE(ms.product_count,0)=1 THEN 'map_sku'
          WHEN COALESCE(mf.product_count,0)>1 OR COALESCE(ms.product_count,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket IN ('direct_resolved','map_fnsku','map_sku'))::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const e2Approved = approvalTrue(E2_APPROVAL, [
    "APPROVED_TO_RUN_STAGING",
    "APPROVED_EXPECTED_PACKAGES_E2_PRODUCT_PROMOTION_V194",
  ]);
  if (!e2Approved) throw new Error(`E2 approval flags are not true in ${E2_APPROVAL}`);
  const apiApproval = apiApprovalState();

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const beforeCoverage = await coverage(client);
  const beforeCounts = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages
  `);

  const candidates = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id, NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku=ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku=ep.sku OR m.msku=ep.sku)
      GROUP BY ep.id
    ),
    trusted_sources AS (
      SELECT ep.id,
        COUNT(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL)::int AS source_product_count,
        COUNT(*) FILTER (WHERE product_name IS NOT NULL)::int AS source_rows_with_name,
        MIN(product_name) FILTER (WHERE product_name IS NOT NULL) AS sample_product_name,
        MIN(source_asin) FILTER (WHERE source_asin IS NOT NULL) AS sample_asin,
        ARRAY_AGG(DISTINCT src) FILTER (WHERE src IS NOT NULL) AS source_tables,
        ARRAY_AGG(DISTINCT source_row_id) FILTER (WHERE source_row_id IS NOT NULL) AS source_row_ids
      FROM ep
      LEFT JOIN LATERAL (
        SELECT 'amazon_amazon_fulfilled_inventory'::text AS src, a.id::text AS source_row_id,
          COALESCE(a.resolved_product_id, a.product_id) AS source_product_id,
          NULL::text AS product_name, NULLIF(TRIM(a.asin),'') AS source_asin
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE a.organization_id=ep.organization_id AND a.store_id=ep.store_id
          AND ((ep.fnsku IS NOT NULL AND a.fulfillment_channel_sku=ep.fnsku)
            OR (ep.sku IS NOT NULL AND a.seller_sku=ep.sku))
        UNION ALL
        SELECT 'amazon_fba_inventory'::text, f.id::text, COALESCE(f.resolved_product_id, f.product_id),
          NULLIF(TRIM(f.product_name),''), NULLIF(TRIM(f.asin),'')
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id=ep.organization_id AND f.store_id=ep.store_id
          AND ((ep.fnsku IS NOT NULL AND f.fnsku=ep.fnsku) OR (ep.sku IS NOT NULL AND f.sku=ep.sku))
        UNION ALL
        SELECT 'amazon_manage_fba_inventory'::text, mf.id::text, COALESCE(mf.resolved_product_id, mf.product_id),
          NULLIF(TRIM(mf.product_name),''), NULLIF(TRIM(mf.asin),'')
        FROM public.amazon_manage_fba_inventory mf
        WHERE mf.organization_id=ep.organization_id AND mf.store_id=ep.store_id
          AND ((ep.fnsku IS NOT NULL AND mf.fnsku=ep.fnsku) OR (ep.sku IS NOT NULL AND mf.sku=ep.sku))
      ) s ON true
      GROUP BY ep.id
    ),
    e2_rows AS (
      SELECT ep.*, ts.sample_product_name, ts.sample_asin, ts.source_tables, ts.source_row_ids
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
      JOIN trusted_sources ts ON ts.id=ep.id
      WHERE ep.resolved_product_id IS NULL
        AND COALESCE(mf.product_count,0)=0
        AND COALESCE(ms.product_count,0)=0
        AND COALESCE(ts.source_product_count,0)=0
        AND COALESCE(ts.source_rows_with_name,0)>0
    ),
    grouped AS (
      SELECT organization_id, store_id, sku, fnsku, sample_asin AS asin, sample_product_name AS product_name,
        COUNT(DISTINCT id)::int AS expected_package_count,
        ARRAY_AGG(DISTINCT id::text ORDER BY id::text) AS expected_package_ids,
        ARRAY_AGG(DISTINCT unnest_source_table) AS source_tables,
        ARRAY_AGG(DISTINCT unnest_source_row_id) AS source_row_ids
      FROM e2_rows
      LEFT JOIN LATERAL UNNEST(COALESCE(source_tables, ARRAY[]::text[])) unnest_source_table ON true
      LEFT JOIN LATERAL UNNEST(COALESCE(source_row_ids, ARRAY[]::text[])) unnest_source_row_id ON true
      GROUP BY organization_id, store_id, sku, fnsku, sample_asin, sample_product_name
    )
    SELECT * FROM grouped ORDER BY sku, fnsku
  `);

  fs.writeFileSync(path.join(outDir, "candidate-preimage.json"), JSON.stringify(candidates.rows, null, 2));
  if (candidates.rows.length !== 19) {
    await client.end();
    throw new Error(`Expected 19 E2 promotion candidates, found ${candidates.rows.length}`);
  }

  const conflict = await client.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        organization_id uuid, store_id uuid, sku text, fnsku text, asin text
      )
    )
    SELECT i.*, p.id::text AS existing_product_id
    FROM input i
    JOIN public.products p ON p.organization_id=i.organization_id AND p.store_id=i.store_id AND p.deleted_at IS NULL
     AND (
       (i.fnsku IS NOT NULL AND p.fnsku=i.fnsku)
       OR (i.sku IS NOT NULL AND p.sku=i.sku)
       OR (i.asin IS NOT NULL AND p.asin=i.asin)
     )
  `,
    [JSON.stringify(candidates.rows)],
  );
  if (conflict.rows.length > 0) {
    fs.writeFileSync(path.join(outDir, "blockers.json"), JSON.stringify(conflict.rows, null, 2));
    await client.end();
    throw new Error("Existing product conflicts found; no E2 execute performed.");
  }

  let insertedProducts: Record<string, unknown>[] = [];
  let insertedMaps: Record<string, unknown>[] = [];
  await client.query("BEGIN");
  try {
    const res = await client.query(
      `
      WITH input AS (
        SELECT *, row_number() OVER (ORDER BY sku, fnsku) AS rn
        FROM jsonb_to_recordset($1::jsonb) AS x(
          organization_id uuid,
          store_id uuid,
          sku text,
          fnsku text,
          asin text,
          product_name text,
          expected_package_count int,
          expected_package_ids text[],
          source_tables text[],
          source_row_ids text[]
        )
      ),
      inserted_products AS (
        INSERT INTO public.products (
          organization_id, store_id, product_name, sku, fnsku, asin, status,
          metadata, first_seen_at, last_seen_at, created_at, updated_at
        )
        SELECT organization_id, store_id, product_name, sku, fnsku, asin, 'active',
          jsonb_build_object(
            'source', $2::text,
            'expected_package_ids', expected_package_ids,
            'source_tables', source_tables,
            'source_row_ids', source_row_ids
          ),
          now(), now(), now(), now()
        FROM input
        RETURNING id, organization_id, store_id, product_name, sku, fnsku, asin
      ),
      numbered_products AS (
        SELECT ip.*, row_number() OVER (ORDER BY ip.sku, ip.fnsku) AS rn
        FROM inserted_products ip
      ),
      inserted_maps AS (
        INSERT INTO public.product_identifier_map (
          organization_id, store_id, product_id, seller_sku, msku, asin, fnsku,
          match_source, source_report_type, external_listing_id, is_primary,
          first_seen_at, last_seen_at, created_at, updated_at
        )
        SELECT
          i.organization_id, i.store_id, p.id, i.sku, i.sku, i.asin, i.fnsku,
          $2::text, $2::text, $2::text || ':' || p.id::text, true,
          now(), now(), now(), now()
        FROM input i
        JOIN numbered_products p ON p.rn=i.rn
        RETURNING id, product_id, seller_sku, msku, fnsku, asin, external_listing_id
      )
      SELECT
        (SELECT jsonb_agg(to_jsonb(inserted_products)) FROM inserted_products) AS products,
        (SELECT jsonb_agg(to_jsonb(inserted_maps)) FROM inserted_maps) AS maps
    `,
      [JSON.stringify(candidates.rows), MATCH_SOURCE],
    );
    insertedProducts = (res.rows[0]?.products ?? []) as Record<string, unknown>[];
    insertedMaps = (res.rows[0]?.maps ?? []) as Record<string, unknown>[];
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const afterCoverage = await coverage(client);
  const afterCounts = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source=$1 AND deleted_at IS NULL) AS e2_map_rows
  `, [MATCH_SOURCE]);
  await client.end();

  fs.writeFileSync(path.join(outDir, "inserted-products.json"), JSON.stringify(insertedProducts, null, 2));
  fs.writeFileSync(path.join(outDir, "inserted-map-rows.json"), JSON.stringify(insertedMaps, null, 2));
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback V194 E2 product promotion execute. Run only if no downstream review accepted these rows.",
      "DELETE FROM public.product_identifier_map",
      `WHERE external_listing_id IN (${insertedMaps.map((r) => `'${String(r.external_listing_id).replace(/'/g, "''")}'`).join(", ")});`,
      "",
      "DELETE FROM public.products",
      `WHERE id IN (${insertedProducts.map((r) => `'${String(r.id).replace(/'/g, "''")}'::uuid`).join(", ")});`,
      "",
    ].join("\n"),
  );

  const manifest = {
    prompt: "EXPECTED-PACKAGES-E2-PRODUCT-PROMOTION-EXECUTE-V194",
    run_id: runId,
    staging_ref: STAGING_REF,
    status: "PASS",
    api_approval: apiApproval,
    api_called: false,
    e2_candidates: candidates.rows.length,
    products_inserted: insertedProducts.length,
    map_rows_inserted: insertedMaps.length,
    expected_packages_updated: false,
    before_coverage: beforeCoverage,
    after_coverage: afterCoverage,
    before_counts: beforeCounts.rows[0],
    after_counts: afterCounts.rows[0],
    forbidden: {
      production_touched: false,
      amazon_api_called: false,
      ai_or_openai_called: false,
      package_items_created: false,
      fuzzy_title_ocr_used: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Expected Packages E2 Product Promotion Execute V194",
      "",
      `- Product rows inserted: **${insertedProducts.length}**`,
      `- Map rows inserted: **${insertedMaps.length}**`,
      `- Expected packages updated: **0**`,
      `- Read-layer resolved: ${beforeCoverage.read_layer_resolved} -> **${afterCoverage.read_layer_resolved}**`,
      `- Unresolved: ${beforeCoverage.unresolved} -> **${afterCoverage.unresolved}**`,
      "",
      `Amazon API approval state: \`${apiApproval.note}\`; API was not called.`,
    ].join("\n"),
  );
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
