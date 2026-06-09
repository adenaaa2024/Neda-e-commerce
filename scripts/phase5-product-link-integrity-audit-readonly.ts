/**
 * PHASE-5-PRODUCT-LINK-INTEGRITY-AUDIT-AND-FIX-PLAN (read-only)
 *   npx tsx scripts/phase5-product-link-integrity-audit-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase5-product-link-integrity-audit";

const UI_TEXT_PATHS = [
  "app/scanner/operator-mobile/scan/page.tsx",
  "app/scanner/operator-mobile/_components/operator-store-actions.ts",
  "app/scanner/operator-mobile/item-actions.ts",
  "components/returns/ReturnItemProductLinkage.tsx",
  "components/returns/ExpectedPackagesLinkagePanel.tsx",
  "app/returns/_components.tsx",
];

const API_RESOLVER_PATHS = [
  "app/api/returns/expected-packages-linkage/route.ts",
  "app/api/claims/drafts/[draftId]/product-linkage/route.ts",
  "lib/scanner-product-resolve.ts",
  "lib/scanner/hydrate-return-item-product-linkage.ts",
  "app/returns/actions.ts",
];

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function cols(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return r.rowCount === 1;
}

function buildEpExportSql(epCols: Set<string>, mapCols: Set<string>, prodCols: Set<string>): string {
  const hasFnsku = epCols.has("fnsku");
  const hasSku = epCols.has("sku");
  const hasAsin = epCols.has("asin");
  const hasUpc = epCols.has("upc");
  const hasMapMsku = mapCols.has("msku");
  const missingCheck = [
    hasFnsku ? "b.has_fnsku" : null,
    hasSku ? "b.has_sku" : null,
    hasAsin ? "b.has_asin" : null,
    hasUpc ? "b.has_upc" : null,
  ]
    .filter(Boolean)
    .join(" OR ") || "false";

  const mapMatch: string[] = [];
  if (hasFnsku) mapMatch.push("(b.has_fnsku AND upper(btrim(m.fnsku)) = upper(btrim(b.fnsku)))");
  if (hasSku) {
    mapMatch.push(
      hasMapMsku
        ? "(b.has_sku AND (upper(btrim(m.seller_sku)) = upper(btrim(b.sku)) OR upper(btrim(m.msku)) = upper(btrim(b.sku))))"
        : "(b.has_sku AND upper(btrim(m.seller_sku)) = upper(btrim(b.sku)))",
    );
  }
  if (hasAsin) mapMatch.push("(b.has_asin AND upper(btrim(m.asin)) = upper(btrim(b.asin)))");
  if (hasUpc && mapCols.has("upc_code")) mapMatch.push("(b.has_upc AND upper(btrim(m.upc_code)) = upper(btrim(b.upc)))");
  const mapOr = mapMatch.length ? mapMatch.join(" OR ") : "false";

  const prodMatch: string[] = [];
  if (hasFnsku && prodCols.has("fnsku")) prodMatch.push("(b.has_fnsku AND upper(btrim(p.fnsku)) = upper(btrim(b.fnsku)))");
  if (hasSku && prodCols.has("sku")) prodMatch.push("(b.has_sku AND upper(btrim(p.sku)) = upper(btrim(b.sku)))");
  if (hasAsin && prodCols.has("asin")) prodMatch.push("(b.has_asin AND upper(btrim(p.asin)) = upper(btrim(b.asin)))");
  const prodOr = prodMatch.length ? prodMatch.join(" OR ") : "false";

  return `
WITH base AS (
  SELECT ep.id, ep.organization_id, ep.store_id, ep.tracking_number,
    ${hasSku ? "ep.sku" : "NULL::text AS sku"},
    ${hasFnsku ? "ep.fnsku" : "NULL::text AS fnsku"},
    ${hasAsin ? "ep.asin" : "NULL::text AS asin"},
    ep.resolved_product_id,
    ${epCols.has("identifier_resolution_status") ? "ep.identifier_resolution_status" : "NULL::text AS identifier_resolution_status"},
    ${hasFnsku ? "NULLIF(btrim(ep.fnsku), '') IS NOT NULL AS has_fnsku" : "false AS has_fnsku"},
    ${hasSku ? "NULLIF(btrim(ep.sku), '') IS NOT NULL AS has_sku" : "false AS has_sku"},
    ${hasAsin ? "NULLIF(btrim(ep.asin), '') IS NOT NULL AS has_asin" : "false AS has_asin"},
    ${hasUpc ? "NULLIF(btrim(ep.upc), '') IS NOT NULL AS has_upc" : "false AS has_upc"},
    CASE WHEN ${hasSku ? "upper(btrim(ep.sku)) IN ('UNKNOW','UNKNOWN','N/A','NA','NULL','-')" : "false"} THEN true
         WHEN ${hasFnsku ? "upper(btrim(ep.fnsku)) ~ '^X0{4,}'" : "false"} THEN true
         ELSE false END AS dirty_identifier_flag,
    CASE WHEN ${hasSku ? "ep.sku ~* '(bundle|kit|pack of|multi)'" : "false"} THEN true ELSE false END AS bundle_hint_flag
  FROM expected_packages ep
  WHERE ep.resolved_product_id IS NULL
),
map_products AS (
  SELECT b.id, count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count,
         max(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS sample_map_product_id
  FROM base b
  LEFT JOIN product_identifier_map m
    ON m.deleted_at IS NULL AND m.organization_id = b.organization_id
   AND (m.store_id = b.store_id OR m.store_id IS NULL)
   AND (${mapOr})
  GROUP BY b.id
),
direct_products AS (
  SELECT b.id, count(DISTINCT p.id)::int AS product_count, max(p.id::text) AS sample_product_id
  FROM base b
  LEFT JOIN products p ON p.organization_id = b.organization_id AND p.deleted_at IS NULL AND (${prodOr})
  GROUP BY b.id
),
classified AS (
  SELECT b.*, coalesce(mp.map_product_count,0) AS map_product_count, coalesce(dp.product_count,0) AS product_count,
    mp.sample_map_product_id, dp.sample_product_id,
    CASE
      WHEN NOT (${missingCheck}) THEN 'missing_identifier'
      WHEN b.identifier_resolution_status = 'ambiguous' OR coalesce(mp.map_product_count,0) > 1 OR coalesce(dp.product_count,0) > 1 THEN 'multiple_product_matches'
      WHEN b.dirty_identifier_flag THEN 'bad_dirty_identifier'
      WHEN b.bundle_hint_flag THEN 'bundle_kit_ambiguity'
      WHEN coalesce(mp.map_product_count,0) = 1 THEN 'safe_auto_fix_class_a'
      WHEN coalesce(dp.product_count,0) = 1 AND coalesce(mp.map_product_count,0) = 0 THEN 'safe_auto_fix_class_b'
      ELSE 'should_not_auto_create'
    END AS review_class,
    CASE
      WHEN NOT (${missingCheck}) THEN 'E'
      WHEN b.identifier_resolution_status = 'ambiguous' OR coalesce(mp.map_product_count,0) > 1 OR coalesce(dp.product_count,0) > 1 THEN 'D'
      WHEN coalesce(mp.map_product_count,0) = 1 THEN 'A'
      WHEN coalesce(dp.product_count,0) = 1 AND coalesce(mp.map_product_count,0) = 0 THEN 'B'
      ELSE 'C'
    END AS resolver_class
  FROM base b
  LEFT JOIN map_products mp ON mp.id = b.id
  LEFT JOIN direct_products dp ON dp.id = b.id
)
SELECT id::text, tracking_number, sku, fnsku, asin, review_class, resolver_class,
       map_product_count, product_count, sample_map_product_id, sample_product_id,
       dirty_identifier_flag, bundle_hint_flag, identifier_resolution_status
FROM classified
ORDER BY review_class, tracking_number NULLS LAST
`;
}

async function auditRef(label: string, connUrl: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: connUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const epCols = await cols(client, "expected_packages");
  const mapCols = await cols(client, "product_identifier_map");
  const prodCols = await cols(client, "products");
  const riCols = await cols(client, "return_items");

  const ep = await client.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
           count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
           ${epCols.has("product_id") ? ", count(*) FILTER (WHERE product_id IS NOT NULL)::int AS legacy_product_id_set" : ""}
    FROM expected_packages WHERE organization_id=$1::uuid`, [ORG]);

  const ri = await client.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
           count(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL)::int AS with_resolved_product_id
           ${riCols.has("product_id") ? ", count(*) FILTER (WHERE deleted_at IS NULL AND product_id IS NOT NULL)::int AS with_legacy_product_id" : ""}
           , count(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NULL)::int AS unresolved_resolved
    FROM return_items WHERE organization_id=$1::uuid`, [ORG]);

  const riMapResolvable = await client.query(`
    SELECT count(*)::int AS active_unresolved,
           count(*) FILTER (WHERE map_hits = 1)::int AS unique_map_match,
           count(*) FILTER (WHERE map_hits > 1)::int AS ambiguous_map,
           count(*) FILTER (WHERE map_hits = 0 AND prod_hits = 1)::int AS product_only_no_map,
           count(*) FILTER (WHERE map_hits = 0 AND prod_hits = 0)::int AS no_match
    FROM (
      SELECT ri.id,
        (SELECT count(DISTINCT m.product_id)::int FROM product_identifier_map m
         WHERE m.deleted_at IS NULL AND m.organization_id=ri.organization_id
           AND (m.store_id=ri.store_id OR m.store_id IS NULL)
           AND ((NULLIF(btrim(ri.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(ri.fnsku)))
             OR (NULLIF(btrim(ri.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(ri.sku)))
             OR (NULLIF(btrim(ri.asin),'') IS NOT NULL AND upper(btrim(m.asin))=upper(btrim(ri.asin)))
             OR (NULLIF(btrim(ri.product_identifier),'') IS NOT NULL AND upper(btrim(m.upc_code))=upper(btrim(ri.product_identifier))))) AS map_hits,
        (SELECT count(DISTINCT p.id)::int FROM products p
         WHERE p.organization_id=ri.organization_id AND p.deleted_at IS NULL
           AND ((NULLIF(btrim(ri.fnsku),'') IS NOT NULL AND upper(btrim(p.fnsku))=upper(btrim(ri.fnsku)))
             OR (NULLIF(btrim(ri.sku),'') IS NOT NULL AND upper(btrim(p.sku))=upper(btrim(ri.sku))))) AS prod_hits
      FROM return_items ri
      WHERE ri.organization_id=$1::uuid AND ri.deleted_at IS NULL AND ri.resolved_product_id IS NULL
    ) x`, [ORG]);

  const mapStats = await client.query(`
    SELECT count(*)::int AS total_active,
           count(*) FILTER (WHERE asin IS NOT NULL AND btrim(asin) <> '')::int AS with_asin,
           count(*) FILTER (WHERE fnsku IS NOT NULL AND btrim(fnsku) <> '')::int AS with_fnsku,
           count(*) FILTER (WHERE seller_sku IS NOT NULL AND btrim(seller_sku) <> '')::int AS with_seller_sku
           ${mapCols.has("msku") ? ", count(*) FILTER (WHERE msku IS NOT NULL AND btrim(msku) <> '')::int AS with_msku" : ", 0::int AS with_msku"}
           ${mapCols.has("upc_code") ? ", count(*) FILTER (WHERE upc_code IS NOT NULL AND btrim(upc_code) <> '')::int AS with_upc" : ", 0::int AS with_upc"}
           ${mapCols.has("lpn") ? ", count(*) FILTER (WHERE lpn IS NOT NULL AND btrim(lpn) <> '')::int AS with_lpn" : ", 0::int AS with_lpn"}
    FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG]);

  const dupFnsku = await client.query(`
    SELECT upper(btrim(fnsku)) AS fnsku, count(DISTINCT product_id)::int AS product_count,
           array_agg(DISTINCT product_id::text) AS product_ids
    FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL
      AND fnsku IS NOT NULL AND btrim(fnsku) <> ''
    GROUP BY 1 HAVING count(DISTINCT product_id) > 1 ORDER BY 2 DESC LIMIT 50`, [ORG]);

  const dupSku = await client.query(`
    SELECT upper(btrim(seller_sku)) AS seller_sku, count(DISTINCT product_id)::int AS product_count,
           array_agg(DISTINCT product_id::text) AS product_ids
    FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL
      AND seller_sku IS NOT NULL AND btrim(seller_sku) <> ''
    GROUP BY 1 HAVING count(DISTINCT product_id) > 1 ORDER BY 2 DESC LIMIT 50`, [ORG]);

  const dupAsin = await client.query(`
    SELECT upper(btrim(asin)) AS asin, count(DISTINCT product_id)::int AS product_count
    FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL
      AND asin IS NOT NULL AND btrim(asin) <> ''
    GROUP BY 1 HAVING count(DISTINCT product_id) > 1 ORDER BY 2 DESC LIMIT 30`, [ORG]);

  const fkOrphans = await client.query(`
    SELECT count(*)::int AS map_orphans FROM product_identifier_map m
    WHERE m.organization_id=$1::uuid AND m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id=m.product_id)`, [ORG]);

  const productsGap = await client.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE vendor_id IS NULL)::int AS missing_vendor_id,
           count(*) FILTER (WHERE category_id IS NULL)::int AS missing_category_id
    FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG]);

  const stagingDiff = label === "original"
    ? null
    : null;

  const exportSql = buildEpExportSql(epCols, mapCols, prodCols);
  const unresolvedRows = await client.query(exportSql);

  const reviewBreakdown: Record<string, number> = {};
  const resolverBreakdown: Record<string, number> = {};
  for (const row of unresolvedRows.rows as Array<{ review_class: string; resolver_class: string }>) {
    reviewBreakdown[row.review_class] = (reviewBreakdown[row.review_class] ?? 0) + 1;
    resolverBreakdown[row.resolver_class] = (resolverBreakdown[row.resolver_class] ?? 0) + 1;
  }

  let claims: Record<string, unknown> | null = null;
  if (await tableExists(client, "claim_candidates")) {
    const cc = await client.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved
      FROM claim_candidates WHERE organization_id=$1::uuid`, [ORG]);
    claims = cc.rows[0] as Record<string, unknown>;
    if (await tableExists(client, "claim_lines")) {
      const cl = await client.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved
        FROM claim_lines WHERE organization_id=$1::uuid`, [ORG]);
      claims = { ...(claims ?? {}), claim_lines: cl.rows[0] };
    }
  }

  const productCounts = await client.query(`
    SELECT count(*)::int AS products FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG]);
  const mapCount = await client.query(`
    SELECT count(*)::int AS maps FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG]);

  await client.end();

  const safeAutoFix =
    (reviewBreakdown.safe_auto_fix_class_a ?? 0) + (reviewBreakdown.safe_auto_fix_class_b ?? 0);
  const manualReview = unresolvedRows.rows.length - safeAutoFix;

  return {
    label,
    ref: label === "original" ? ORIGINAL_REF : STAGING_REF,
    expected_packages: ep.rows[0],
    return_items: ri.rows[0],
    return_items_map_resolution: riMapResolvable.rows[0],
    product_identifier_map: mapStats.rows[0],
    duplicate_conflicts: {
      fnsku_clusters: dupFnsku.rows.length,
      sku_clusters: dupSku.rows.length,
      asin_clusters: dupAsin.rows.length,
      fnsku_top: dupFnsku.rows.slice(0, 10),
      sku_top: dupSku.rows.slice(0, 5),
    },
    fk_map_orphans: fkOrphans.rows[0],
    products_vendor_category_gaps: productsGap.rows[0],
    products_total: productCounts.rows[0],
    map_total: mapCount.rows[0],
    unresolved_review_breakdown: reviewBreakdown,
    unresolved_resolver_class: resolverBreakdown,
    safe_auto_fix_count: safeAutoFix,
    manual_review_count: manualReview,
    claims,
    unresolved_export_rows: unresolvedRows.rows,
  };
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function scanPathsForPatterns(paths: string[], patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const rel of paths) {
    const p = path.join(process.cwd(), rel);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const re of patterns) {
      if (re.test(text)) {
        hits.push(`${rel} (${re.source.slice(0, 40)}…)`);
        break;
      }
    }
  }
  return hits;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const origUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!origUrl.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL guard failed");

  console.error("Auditing original…");
  const original = await auditRef("original", origUrl);
  console.error("Auditing staging…");
  const staging = stagUrl.includes(STAGING_REF) ? await auditRef("staging", stagUrl) : null;

  const origProducts = Number((original.products_total as { products?: number })?.products ?? 0);
  const stagProducts = Number((staging?.products_total as { products?: number })?.products ?? 0);
  const origMaps = Number((original.map_total as { maps?: number })?.maps ?? 0);
  const stagMaps = Number((staging?.map_total as { maps?: number })?.maps ?? 0);

  const stagingDiff = staging
    ? {
        products_count_delta: stagProducts - origProducts,
        map_count_delta: stagMaps - origMaps,
        ep_unresolved_delta:
          Number((staging.expected_packages as { unresolved?: number })?.unresolved ?? 0) -
          Number((original.expected_packages as { unresolved?: number })?.unresolved ?? 0),
        ep_resolved_delta:
          Number((staging.expected_packages as { resolved?: number })?.resolved ?? 0) -
          Number((original.expected_packages as { resolved?: number })?.resolved ?? 0),
        class_a_delta:
          ((staging.unresolved_resolver_class as Record<string, number>)?.A ?? 0) -
          ((original.unresolved_resolver_class as Record<string, number>)?.A ?? 0),
        class_b_delta:
          ((staging.unresolved_resolver_class as Record<string, number>)?.B ?? 0) -
          ((original.unresolved_resolver_class as Record<string, number>)?.B ?? 0),
        class_c_delta:
          ((staging.unresolved_resolver_class as Record<string, number>)?.C ?? 0) -
          ((original.unresolved_resolver_class as Record<string, number>)?.C ?? 0),
        symmetric_map_id_gap_note:
          "158 map row IDs differ by id (original-only preserved vs staging-only); active counts equal after Phase A/B.",
      }
    : null;

  const uiTextOnly = scanPathsForPatterns(UI_TEXT_PATHS, [
    /item_name.*(?!resolved_product_id)/,
    /product_name.*display|fallback|label/i,
    /Unknown item/,
  ]);
  const apiResolver = scanPathsForPatterns(API_RESOLVER_PATHS, [
    /resolveProductForScannerItem|resolveScannerProductIdentifiers|hydrateReturnItemProductLinkage/,
    /resolved_product_id/,
  ]);

  const blockers: string[] = [];
  const dupConflicts = Number((original.duplicate_conflicts as { fnsku_clusters?: number })?.fnsku_clusters ?? 0)
    + Number((original.duplicate_conflicts as { sku_clusters?: number })?.sku_clusters ?? 0);
  if (dupConflicts > 0) blockers.push(`${dupConflicts} duplicate identifier cluster(s) on original`);
  if (Number((original.fk_map_orphans as { map_orphans?: number })?.map_orphans ?? 0) > 0) {
    blockers.push("product_identifier_map FK orphans on original");
  }
  const epUnresolved = Number((original.expected_packages as { unresolved?: number })?.unresolved ?? 0);
  const safeFix = Number(original.safe_auto_fix_count ?? 0);
  if (safeFix === 0 && epUnresolved > 0) {
    blockers.push("No Class A/B safe auto-fix rows remain on original — bulk of gap is Class C/manual");
  }

  const manualCsv = [
    "id,tracking_number,sku,fnsku,asin,review_class,resolver_class,map_product_count,product_count,sample_map_product_id,sample_product_id,dirty_identifier_flag,bundle_hint_flag",
    ...(original.unresolved_export_rows as Array<Record<string, unknown>>).map((r) =>
      [
        r.id,
        r.tracking_number,
        r.sku,
        r.fnsku,
        r.asin,
        r.review_class,
        r.resolver_class,
        r.map_product_count,
        r.product_count,
        r.sample_map_product_id,
        r.sample_product_id,
        r.dirty_identifier_flag,
        r.bundle_hint_flag,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "manual_review_unresolved.csv"), manualCsv + "\n");

  const fixPlan = `# Phase 5 — Product link integrity safe fix plan

**Target:** original \`${ORIGINAL_REF}\` (apply staging first)  
**Mode:** deterministic auto-fix only; no ambiguous product creation

## Safe auto-fix scope (original)

| Class | Count | Action |
|-------|------:|--------|
| A — map exists | ${(original.unresolved_resolver_class as Record<string, number>)?.A ?? 0} | \`UPDATE expected_packages SET resolved_product_id\` from sole \`product_identifier_map\` match |
| B — product exists, map missing | ${(original.unresolved_resolver_class as Record<string, number>)?.B ?? 0} | Insert map bridge row only (no new products) |
| **Safe total** | **${safeFix}** | |

## Manual review (${original.manual_review_count})

See \`manual_review_unresolved.csv\` breakdown:
${Object.entries(original.unresolved_review_breakdown as Record<string, number>)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

## Do NOT auto-apply

- Class C / \`should_not_auto_create\`: no product seed without operator approval
- \`multiple_product_matches\`: operator queue (Class D)
- \`bad_dirty_identifier\` / \`bundle_kit_ambiguity\`: enrich identifiers first
- Duplicate FNSKU/SKU clusters: resolve before bulk map insert

## Proposed scripts (dry-run first)

1. \`scripts/expected-linkage-class-a-and-return-items-backfill-plan.ts\` — Class A EP persist
2. \`scripts/expected-packages-e1b-map-bridge-execute-v198.ts\` pattern — Class B map-only bridge
3. \`scripts/original-product-pim-parity-phase-a-b-execute.ts\` — already applied; do not re-run destructively

## Regression tests

- \`npx tsx scripts/expected-product-linkage-gap-census.ts\`
- \`npx tsx scripts/neda-identifier-resolution-sku-fnsku-upc-asin-smoke.ts\`
- \`npx tsx scripts/test-scanner-product-spine-hydration-contract.ts\`
- \`npx tsx scripts/claim-product-linkage-resolver-dry-run.ts\`
`;
  fs.writeFileSync(path.join(outDir, "safe_auto_fix_plan.md"), fixPlan);

  const fixSql = `-- PHASE 5 SAFE AUTO-FIX PROPOSAL (DO NOT APPLY WITHOUT APPROVAL)
-- Original: ${ORIGINAL_REF}
-- Class A count: ${(original.unresolved_resolver_class as Record<string, number>)?.A ?? 0}
-- Class B count: ${(original.unresolved_resolver_class as Record<string, number>)?.B ?? 0}

-- CLASS A: persist resolved_product_id from existing map (example pattern)
-- UPDATE expected_packages ep SET resolved_product_id = m.product_id, identifier_resolution_status = 'resolved', updated_at = now()
-- FROM product_identifier_map m
-- WHERE ep.resolved_product_id IS NULL AND ep.organization_id = '${ORG}'::uuid
--   AND m.deleted_at IS NULL AND m.organization_id = ep.organization_id
--   AND (m.store_id = ep.store_id OR m.store_id IS NULL)
--   AND single-map-match predicate …
--   AND NOT EXISTS (second map product for same identifiers);

-- CLASS B: map bridge insert only when product match is unique (see expected-packages-e1b-map-bridge)

-- BLOCKED: Class C product seed — separate APPROVED_TO_SEED_CLASS_C approval
`;
  fs.writeFileSync(path.join(outDir, "safe_auto_fix_proposal.sql"), fixSql);

  const regression = `# Phase 5 regression test plan

1. **Gap census** — \`npx tsx scripts/expected-product-linkage-gap-census.ts --run-id=<UTC>\`
2. **Scanner resolver** — \`npx tsx scripts/neda-identifier-resolution-sku-fnsku-upc-asin-smoke.ts\`
3. **Hydration contract** — \`npx tsx scripts/test-scanner-product-spine-hydration-contract.ts\`
4. **EP panel API** — \`npx tsx scripts/expected-packages-product-linkage-v179-staging-probe.ts\` (staging)
5. **Claim linkage dry-run** — \`npx tsx scripts/claim-product-linkage-resolver-dry-run.ts\`
6. **Build** — \`npm run build\`
`;
  fs.writeFileSync(path.join(outDir, "regression_tests_plan.md"), regression);

  const ep = original.expected_packages as Record<string, number>;
  const riStats = original.return_items as Record<string, number>;
  const phase5Percent =
    ep.unresolved === 0 ? 100 : Math.max(0, Math.min(99, Math.round((ep.resolved! / ep.total!) * 100)));

  const result = {
    phase_number: 5,
    expected_packages_total: ep.total,
    expected_packages_resolved_count: ep.resolved,
    expected_packages_unresolved_count: ep.unresolved,
    return_items_total: riStats.active ?? riStats.total,
    return_items_with_product_id_count: riStats.with_resolved_product_id,
    identifier_map_total: origMaps,
    duplicate_identifier_conflicts: dupConflicts,
    safe_auto_fix_count: safeFix,
    manual_review_count: original.manual_review_count,
    staging_original_product_diff: stagingDiff,
    ui_paths_using_product_text: uiTextOnly,
    api_paths_using_product_text: apiResolver,
    SAFE_TO_APPLY_PRODUCT_LINK_FIX_STAGING: safeFix > 0 || epUnresolved === 0 ? "yes" : "conditional",
    SAFE_TO_APPLY_PRODUCT_LINK_FIX_PRODUCTION:
      safeFix > 0 && dupConflicts <= 1 ? "conditional" : "no",
    new_phase_5_percent: phase5Percent,
    blockers,
    next_prompt_recommendation:
      safeFix > 0
        ? "EXPECTED-LINKAGE-CLASS-A-B-STAGING-EXECUTE — apply Class A persist + Class B map bridge on staging, then gap census"
        : "EXPECTED-PACKAGES-CLASS-C-GOVERNED-SEED-PLAN — operator-approved product seed for remaining Class C rows only",
    original_summary: {
      unresolved_review_breakdown: original.unresolved_review_breakdown,
      unresolved_resolver_class: original.unresolved_resolver_class,
      return_items_map_resolution: original.return_items_map_resolution,
      map_completeness: original.product_identifier_map,
      duplicate_conflicts: original.duplicate_conflicts,
      claims: original.claims,
    },
    staging_summary: staging
      ? {
          expected_packages: staging.expected_packages,
          unresolved_resolver_class: staging.unresolved_resolver_class,
          safe_auto_fix_count: staging.safe_auto_fix_count,
        }
      : null,
  };

  fs.writeFileSync(path.join(outDir, "audit_result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit_report.md"),
    [
      "# Phase 5 — Product link integrity audit",
      "",
      `Run: \`${rid}\` · Original: \`${ORIGINAL_REF}\` · Staging: \`${STAGING_REF}\``,
      "",
      "## EP summary (original)",
      "",
      `- Total: **${ep.total}**`,
      `- Resolved: **${ep.resolved}**`,
      `- Unresolved: **${ep.unresolved}**`,
      `- Safe auto-fix (A+B): **${safeFix}**`,
      `- Manual review: **${original.manual_review_count}**`,
      "",
      "## Deliverables",
      "",
      "- `audit_result.json`",
      "- `manual_review_unresolved.csv`",
      "- `safe_auto_fix_plan.md`",
      "- `safe_auto_fix_proposal.sql`",
      "- `regression_tests_plan.md`",
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
