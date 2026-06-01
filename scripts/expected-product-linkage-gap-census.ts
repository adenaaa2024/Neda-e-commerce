/**
 * EXPECTED-PRODUCT-LINKAGE-GAP-CENSUS (read-only)
 *   npx tsx scripts/expected-product-linkage-gap-census.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/expected-product-linkage-gap-census";

type ClassKey = "A" | "B" | "C" | "D" | "E" | "F";

const CLASS_LABELS: Record<ClassKey, string> = {
  A: "can resolve with existing map",
  B: "needs safe map insert to existing product",
  C: "needs product seed from PIM/sheet",
  D: "ambiguous/conflict",
  E: "missing identifiers",
  F: "view/app display issue only",
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return r.rowCount === 1;
}

async function viewExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return r.rowCount === 1;
}

async function columns(client: pg.Client, name: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function buildEpClassifySql(
  epCols: Set<string>,
  mapCols: Set<string>,
  prodCols: Set<string>,
  mode: "count" | "top100",
): string {
  const hasFnsku = epCols.has("fnsku");
  const hasSku = epCols.has("sku");
  const hasAsin = epCols.has("asin");
  const hasUpc = epCols.has("upc");
  const hasMapMsku = mapCols.has("msku");

  const idFlags: string[] = [];
  if (hasFnsku) idFlags.push("NULLIF(btrim(ep.fnsku), '') IS NOT NULL");
  if (hasSku) idFlags.push("NULLIF(btrim(ep.sku), '') IS NOT NULL");
  if (hasAsin) idFlags.push("NULLIF(btrim(ep.asin), '') IS NOT NULL");
  if (hasUpc) idFlags.push("NULLIF(btrim(ep.upc), '') IS NOT NULL");

  const baseSelect = [
    "ep.id",
    "ep.organization_id",
    "ep.store_id",
    "ep.tracking_number",
    hasSku ? "ep.sku" : "NULL::text AS sku",
    hasFnsku ? "ep.fnsku" : "NULL::text AS fnsku",
    hasAsin ? "ep.asin" : "NULL::text AS asin",
    "ep.resolved_product_id",
    epCols.has("identifier_resolution_status")
      ? "ep.identifier_resolution_status"
      : "NULL::text AS identifier_resolution_status",
    hasFnsku ? "NULLIF(btrim(ep.fnsku), '') IS NOT NULL AS has_fnsku" : "false AS has_fnsku",
    hasSku ? "NULLIF(btrim(ep.sku), '') IS NOT NULL AS has_sku" : "false AS has_sku",
    hasAsin ? "NULLIF(btrim(ep.asin), '') IS NOT NULL AS has_asin" : "false AS has_asin",
    hasUpc ? "NULLIF(btrim(ep.upc), '') IS NOT NULL AS has_upc" : "false AS has_upc",
  ].join(",\n    ");

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
  if (hasUpc && mapCols.has("upc_code")) {
    mapMatch.push("(b.has_upc AND upper(btrim(m.upc_code)) = upper(btrim(b.upc)))");
  }
  const mapOr = mapMatch.length ? mapMatch.join("\n     OR ") : "false";

  const prodMatch: string[] = [];
  if (hasFnsku && prodCols.has("fnsku")) {
    prodMatch.push("(b.has_fnsku AND upper(btrim(p.fnsku)) = upper(btrim(b.fnsku)))");
  }
  if (hasSku && prodCols.has("sku")) {
    prodMatch.push("(b.has_sku AND upper(btrim(p.sku)) = upper(btrim(b.sku)))");
  }
  if (hasAsin && prodCols.has("asin")) {
    prodMatch.push("(b.has_asin AND upper(btrim(p.asin)) = upper(btrim(b.asin)))");
  }
  if (hasUpc && (prodCols.has("upc_code") || prodCols.has("barcode"))) {
    prodMatch.push(
      prodCols.has("upc_code")
        ? "(b.has_upc AND upper(btrim(p.upc_code)) = upper(btrim(b.upc)))"
        : "(b.has_upc AND upper(btrim(p.barcode)) = upper(btrim(b.upc)))",
    );
  }
  const prodOr = prodMatch.length ? prodMatch.join("\n     OR ") : "false";

  const missingCheck =
    hasFnsku || hasSku || hasAsin || hasUpc
      ? [
          hasFnsku ? "b.has_fnsku" : null,
          hasSku ? "b.has_sku" : null,
          hasAsin ? "b.has_asin" : null,
          hasUpc ? "b.has_upc" : null,
        ]
          .filter(Boolean)
          .join(" OR ")
      : "false";

  if (mode === "count") {
    return `
WITH base AS (
  SELECT ${baseSelect}
  FROM expected_packages ep
  WHERE ep.resolved_product_id IS NULL
),
map_products AS (
  SELECT b.id, count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL) AS map_product_count
  FROM base b
  LEFT JOIN product_identifier_map m
    ON m.deleted_at IS NULL AND m.organization_id = b.organization_id
   AND (m.store_id = b.store_id OR m.store_id IS NULL)
   AND (${mapOr})
  GROUP BY b.id
),
direct_products AS (
  SELECT b.id, count(DISTINCT p.id) AS product_count
  FROM base b
  LEFT JOIN products p
    ON p.organization_id = b.organization_id AND p.store_id = b.store_id
   AND (${prodOr})
  GROUP BY b.id
),
classified AS (
  SELECT b.*, coalesce(mp.map_product_count, 0)::int AS map_product_count,
    coalesce(dp.product_count, 0)::int AS product_count,
    CASE
      WHEN NOT (${missingCheck}) THEN 'E'
      WHEN b.identifier_resolution_status = 'ambiguous' THEN 'D'
      WHEN coalesce(mp.map_product_count, 0) > 1 OR coalesce(dp.product_count, 0) > 1 THEN 'D'
      WHEN coalesce(mp.map_product_count, 0) = 1 THEN 'A'
      WHEN coalesce(dp.product_count, 0) = 1 AND coalesce(mp.map_product_count, 0) = 0 THEN 'B'
      ELSE 'C'
    END AS class
  FROM base b
  LEFT JOIN map_products mp ON mp.id = b.id
  LEFT JOIN direct_products dp ON dp.id = b.id
)
SELECT class, count(*)::int AS n FROM classified GROUP BY class ORDER BY class;
`;
  }

  return `
WITH base AS (
  SELECT ${baseSelect}
  FROM expected_packages ep
  WHERE ep.resolved_product_id IS NULL
),
map_products AS (
  SELECT b.id,
    count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL) AS map_product_count,
    max(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS sample_map_product_id
  FROM base b
  LEFT JOIN product_identifier_map m
    ON m.deleted_at IS NULL AND m.organization_id = b.organization_id
   AND (m.store_id = b.store_id OR m.store_id IS NULL)
   AND (${mapOr})
  GROUP BY b.id
),
direct_products AS (
  SELECT b.id, count(DISTINCT p.id) AS product_count, max(p.id::text) AS sample_product_id
  FROM base b
  LEFT JOIN products p
    ON p.organization_id = b.organization_id AND p.store_id = b.store_id
   AND (${prodOr})
  GROUP BY b.id
),
classified AS (
  SELECT b.id, b.organization_id, b.store_id, b.tracking_number, b.sku, b.fnsku, b.asin,
    b.identifier_resolution_status,
    coalesce(mp.map_product_count, 0)::int AS map_product_count,
    coalesce(dp.product_count, 0)::int AS product_count,
    mp.sample_map_product_id, dp.sample_product_id,
    CASE
      WHEN NOT (${missingCheck}) THEN 'E'
      WHEN b.identifier_resolution_status = 'ambiguous' THEN 'D'
      WHEN coalesce(mp.map_product_count, 0) > 1 OR coalesce(dp.product_count, 0) > 1 THEN 'D'
      WHEN coalesce(mp.map_product_count, 0) = 1 THEN 'A'
      WHEN coalesce(dp.product_count, 0) = 1 AND coalesce(mp.map_product_count, 0) = 0 THEN 'B'
      ELSE 'C'
    END AS class
  FROM base b
  LEFT JOIN map_products mp ON mp.id = b.id
  LEFT JOIN direct_products dp ON dp.id = b.id
)
SELECT * FROM classified
ORDER BY CASE class WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'D' THEN 3 WHEN 'C' THEN 4 ELSE 5 END,
  tracking_number NULLS LAST, id
LIMIT 100;
`;
}

async function censusRef(label: string, ref: string, connUrl: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({
    connectionString: connUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();
  try {
    const out: Record<string, unknown> = { ref, label };

    // 1. expected_packages
    const ep = await client.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
        count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
        count(*) FILTER (WHERE resolved_product_id IS NULL AND identifier_resolution_status = 'ambiguous')::int AS ambiguous_status,
        count(*) FILTER (WHERE resolved_product_id IS NULL AND identifier_resolution_status = 'unresolved')::int AS unresolved_status,
        count(*) FILTER (WHERE store_id IS NULL)::int AS missing_store_id,
        count(*) FILTER (WHERE organization_id IS NULL)::int AS missing_org_id
      FROM expected_packages
    `);
    out.expected_packages = ep.rows[0];

    const epCols = await columns(client, "expected_packages");
    const mapCols = await columns(client, "product_identifier_map");
    const prodCols = await columns(client, "products");

    const epClass = await client.query(buildEpClassifySql(epCols, mapCols, prodCols, "count"));
    out.expected_packages_classification = Object.fromEntries(
      epClass.rows.map((r: { class: string; n: number }) => [r.class, r.n]),
    );

    // 2. v_inventory_item_status
    if (await viewExists(client, "v_inventory_item_status")) {
      const vCols = await columns(client, "v_inventory_item_status");
      const hasEpId = vCols.has("expected_package_id");
      const hasDisplay = vCols.has("product_display_name");
      const viewSql = `
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
          count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
          count(*) FILTER (WHERE product_name IS NOT NULL AND resolved_product_id IS NULL)::int AS name_without_resolved,
          count(*) FILTER (WHERE product_name IS NOT NULL AND resolved_product_id IS NOT NULL)::int AS name_with_resolved,
          count(*) FILTER (WHERE store_id IS NULL)::int AS missing_store_id
          ${hasEpId ? ", count(*) FILTER (WHERE expected_package_id IS NOT NULL AND resolved_product_id IS NULL)::int AS ep_id_but_unresolved" : ""}
          ${hasDisplay ? ", count(*) FILTER (WHERE product_display_name IS NOT NULL AND resolved_product_id IS NULL)::int AS display_without_resolved" : ""}
        FROM v_inventory_item_status
      `;
      const vInv = await client.query(viewSql);
      out.v_inventory_item_status = { columns: [...vCols], ...vInv.rows[0] };

      if (hasEpId) {
        const viewGap = await client.query(`
          SELECT count(*)::int AS n
          FROM v_inventory_item_status v
          INNER JOIN expected_packages ep ON ep.id = v.expected_package_id
          WHERE ep.resolved_product_id IS NOT NULL
            AND v.resolved_product_id IS NULL
        `);
        out.view_display_gap_ep_resolved_view_not = viewGap.rows[0]?.n ?? 0;
        const viewGap2 = await client.query(`
          SELECT count(*)::int AS n
          FROM v_inventory_item_status v
          INNER JOIN expected_packages ep ON ep.id = v.expected_package_id
          WHERE ep.resolved_product_id IS NULL
            AND v.resolved_product_id IS NOT NULL
        `);
        out.view_display_gap_view_resolved_ep_not = viewGap2.rows[0]?.n ?? 0;
      }
    }

    // 3. slip_contents
    if (await tableExists(client, "slip_contents")) {
      const slipCols = await columns(client, "slip_contents");
      const hasResolved = slipCols.has("resolved_product_id");
      const idExpr = slipCols.has("fnsku")
        ? "NULLIF(btrim(fnsku),'') IS NOT NULL OR NULLIF(btrim(parsed_fnsku),'') IS NOT NULL OR NULLIF(btrim(parsed_sku),'') IS NOT NULL OR NULLIF(btrim(parsed_asin),'') IS NOT NULL OR NULLIF(btrim(upc),'') IS NOT NULL OR NULLIF(btrim(parsed_upc),'') IS NOT NULL"
        : "false";
      const slipSql = hasResolved
        ? `
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
          count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
          count(*) FILTER (WHERE resolved_product_id IS NULL AND (${idExpr}))::int AS unresolved_with_identifiers,
          count(*) FILTER (WHERE resolved_product_id IS NULL AND NOT (${idExpr}))::int AS unresolved_missing_identifiers,
          count(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::int AS ambiguous
        FROM slip_contents
      `
        : `SELECT count(*)::int AS total FROM slip_contents`;
      out.slip_contents = { columns: [...slipCols], ...(await client.query(slipSql)).rows[0] };
    }

    // 4. return_items
    if (await tableExists(client, "return_items")) {
      const riCols = await columns(client, "return_items");
      const hasExpectedItem = riCols.has("expected_item_id");
      const hasDeleted = riCols.has("deleted_at");
      const whereActive = hasDeleted ? "WHERE deleted_at IS NULL" : "";
      const riSql = `
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
          count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
          ${hasExpectedItem ? "count(*) FILTER (WHERE expected_item_id IS NOT NULL)::int AS with_expected_item_id," : ""}
          ${hasExpectedItem ? "count(*) FILTER (WHERE expected_item_id IS NULL)::int AS missing_expected_item_id," : ""}
          ${hasExpectedItem ? "count(*) FILTER (WHERE expected_item_id IS NOT NULL AND resolved_product_id IS NULL)::int AS expected_item_unresolved," : ""}
          count(*) FILTER (WHERE resolved_product_id IS NULL AND (NULLIF(btrim(fnsku),'') IS NOT NULL OR NULLIF(btrim(sku),'') IS NOT NULL OR NULLIF(btrim(asin),'') IS NOT NULL OR NULLIF(btrim(product_identifier),'') IS NOT NULL))::int AS unresolved_with_identifiers,
          count(*) FILTER (WHERE store_id IS NULL)::int AS missing_store_id
        FROM return_items
        ${whereActive}
      `;
      out.return_items = { columns: [...riCols], ...(await client.query(riSql)).rows[0] };

      if (hasExpectedItem) {
        const activeFilter = hasDeleted ? "WHERE ri.deleted_at IS NULL" : "";
        const linkCheck = await client.query(`
          SELECT
            count(*)::int AS total_with_expected_item,
            count(*) FILTER (WHERE ep.id IS NOT NULL)::int AS expected_item_fk_valid,
            count(*) FILTER (WHERE ep.id IS NULL)::int AS expected_item_fk_orphan,
            count(*) FILTER (WHERE ep.id IS NOT NULL AND ri.resolved_product_id IS NULL AND ep.resolved_product_id IS NOT NULL)::int AS ep_resolved_return_not,
            count(*) FILTER (WHERE ep.id IS NOT NULL AND ri.resolved_product_id IS NOT NULL AND ep.resolved_product_id IS NULL)::int AS return_resolved_ep_not
          FROM return_items ri
          LEFT JOIN expected_packages ep ON ep.id = ri.expected_item_id
          ${activeFilter}
        `);
        out.return_items_expected_item_link = linkCheck.rows[0];
      }
    }

    // 5. product_identifier_map coverage
    const mapCov = await client.query(`
      SELECT
        count(*)::int AS total_rows,
        count(*) FILTER (WHERE deleted_at IS NULL)::int AS active_rows,
        count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(fnsku),'') IS NOT NULL)::int AS active_with_fnsku,
        count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(seller_sku),'') IS NOT NULL)::int AS active_with_seller_sku,
        count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(asin),'') IS NOT NULL)::int AS active_with_asin,
        count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(upc_code),'') IS NOT NULL)::int AS active_with_upc,
        count(*) FILTER (WHERE deleted_at IS NULL AND store_id IS NULL)::int AS active_org_wide_store_null,
        count(*) FILTER (WHERE deleted_at IS NULL AND product_id IS NULL)::int AS active_missing_product_id
      FROM product_identifier_map
    `);
    out.product_identifier_map = mapCov.rows[0];

    // 6. seller_sku scope by org + store
    const mapScope = await client.query(`
      SELECT
        organization_id::text,
        coalesce(store_id::text, '(org-wide)') AS store_id,
        count(*) FILTER (WHERE deleted_at IS NULL)::int AS active_map_rows,
        count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(seller_sku),'') IS NOT NULL)::int AS active_seller_sku_rows,
        count(DISTINCT seller_sku) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(seller_sku),'') IS NOT NULL)::int AS distinct_seller_sku
      FROM product_identifier_map
      GROUP BY organization_id, store_id
      ORDER BY active_map_rows DESC
      LIMIT 25
    `);
    out.product_identifier_map_scope_top25 = mapScope.rows;

    // 7. top 100 unresolved EP cases
    out.unresolved_top_cases = (
      await client.query(buildEpClassifySql(epCols, mapCols, prodCols, "top100"))
    ).rows;

    // Aggregate classification across sources (EP primary + view F)
    const classCounts: Record<ClassKey, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
    for (const [k, v] of Object.entries(out.expected_packages_classification as Record<string, number>)) {
      if (k in classCounts) classCounts[k as ClassKey] += v;
    }
    const viewFGap = Number(out.view_display_gap_ep_resolved_view_not ?? 0);
    if (viewFGap > 0) classCounts.F += viewFGap;
    out.classification_counts = classCounts;

    return out;
  } finally {
    await client.end();
  }
}

function diffCounts(
  staging: Record<string, unknown>,
  original: Record<string, unknown>,
  path: string,
): Record<string, number | null> {
  const s = (staging[path] ?? {}) as Record<string, number>;
  const o = (original[path] ?? {}) as Record<string, number>;
  const keys = new Set([...Object.keys(s), ...Object.keys(o)]);
  const diff: Record<string, number | null> = {};
  for (const k of keys) {
    if (typeof s[k] === "number" && typeof o[k] === "number") diff[k] = s[k] - o[k];
  }
  return diff;
}

function renderReport(
  runId: string,
  staging: Record<string, unknown>,
  original: Record<string, unknown>,
): string {
  const sEp = staging.expected_packages as Record<string, number>;
  const oEp = original.expected_packages as Record<string, number>;
  const sClass = staging.classification_counts as Record<ClassKey, number>;
  const oClass = original.classification_counts as Record<ClassKey, number>;
  const sMap = staging.product_identifier_map as Record<string, number>;
  const oMap = original.product_identifier_map as Record<string, number>;

  const stagingVsOriginal = {
    expected_packages_unresolved_delta: (sEp?.unresolved ?? 0) - (oEp?.unresolved ?? 0),
    expected_packages_resolved_delta: (sEp?.resolved ?? 0) - (oEp?.resolved ?? 0),
    map_active_rows_delta: (sMap?.active_rows ?? 0) - (oMap?.active_rows ?? 0),
    classification: Object.fromEntries(
      (Object.keys(sClass) as ClassKey[]).map((k) => [k, (sClass[k] ?? 0) - (oClass[k] ?? 0)]),
    ),
  };

  const topCases = (staging.unresolved_top_cases as Record<string, unknown>[]) ?? [];
  const topTable = topCases
    .slice(0, 25)
    .map(
      (r) =>
        `| ${r.class} | \`${String(r.id).slice(0, 8)}…\` | ${r.tracking_number ?? "—"} | ${r.fnsku ?? "—"} | ${r.sku ?? "—"} | ${r.map_product_count} | ${r.product_count} | ${r.identifier_resolution_status ?? "—"} |`,
    )
    .join("\n");

  return `# EXPECTED-PRODUCT-LINKAGE-GAP-CENSUS

Run: \`${runId}\`  
Mode: read-only  
Staging: \`${STAGING_REF}\` · Original: \`${ORIGINAL_REF}\`

# SUMMARY_COUNTS

## expected_packages

| Metric | Staging | Original |
|--------|---------|----------|
| Total | ${sEp?.total ?? "—"} | ${oEp?.total ?? "—"} |
| Resolved | ${sEp?.resolved ?? "—"} | ${oEp?.resolved ?? "—"} |
| Unresolved | ${sEp?.unresolved ?? "—"} | ${oEp?.unresolved ?? "—"} |
| Ambiguous status | ${sEp?.ambiguous_status ?? "—"} | ${oEp?.ambiguous_status ?? "—"} |
| Missing store_id | ${sEp?.missing_store_id ?? "—"} | ${oEp?.missing_store_id ?? "—"} |

## v_inventory_item_status

| Metric | Staging | Original |
|--------|---------|----------|
| Total | ${(staging.v_inventory_item_status as Record<string, number>)?.total ?? "—"} | ${(original.v_inventory_item_status as Record<string, number>)?.total ?? "—"} |
| Resolved | ${(staging.v_inventory_item_status as Record<string, number>)?.resolved ?? "—"} | ${(original.v_inventory_item_status as Record<string, number>)?.resolved ?? "—"} |
| Unresolved | ${(staging.v_inventory_item_status as Record<string, number>)?.unresolved ?? "—"} | ${(original.v_inventory_item_status as Record<string, number>)?.unresolved ?? "—"} |
| Name without resolved | ${(staging.v_inventory_item_status as Record<string, number>)?.name_without_resolved ?? "—"} | ${(original.v_inventory_item_status as Record<string, number>)?.name_without_resolved ?? "—"} |
| EP resolved / view not (F signal) | ${staging.view_display_gap_ep_resolved_view_not ?? 0} | ${original.view_display_gap_ep_resolved_view_not ?? 0} |

## slip_contents

| Metric | Staging | Original |
|--------|---------|----------|
| Total | ${(staging.slip_contents as Record<string, number>)?.total ?? "—"} | ${(original.slip_contents as Record<string, number>)?.total ?? "—"} |
| Resolved | ${(staging.slip_contents as Record<string, number>)?.resolved ?? "—"} | ${(original.slip_contents as Record<string, number>)?.resolved ?? "—"} |
| Unresolved | ${(staging.slip_contents as Record<string, number>)?.unresolved ?? "—"} | ${(original.slip_contents as Record<string, number>)?.unresolved ?? "—"} |
| Unresolved w/ identifiers | ${(staging.slip_contents as Record<string, number>)?.unresolved_with_identifiers ?? "—"} | ${(original.slip_contents as Record<string, number>)?.unresolved_with_identifiers ?? "—"} |

## return_items (active)

| Metric | Staging | Original |
|--------|---------|----------|
| Total | ${(staging.return_items as Record<string, number>)?.total ?? "—"} | ${(original.return_items as Record<string, number>)?.total ?? "—"} |
| Resolved | ${(staging.return_items as Record<string, number>)?.resolved ?? "—"} | ${(original.return_items as Record<string, number>)?.resolved ?? "—"} |
| Unresolved | ${(staging.return_items as Record<string, number>)?.unresolved ?? "—"} | ${(original.return_items as Record<string, number>)?.unresolved ?? "—"} |
| With expected_item_id | ${(staging.return_items as Record<string, number>)?.with_expected_item_id ?? "—"} | ${(original.return_items as Record<string, number>)?.with_expected_item_id ?? "—"} |
| expected_item unresolved | ${(staging.return_items as Record<string, number>)?.expected_item_unresolved ?? "—"} | ${(original.return_items as Record<string, number>)?.expected_item_unresolved ?? "—"} |
| EP resolved / return not | ${(staging.return_items_expected_item_link as Record<string, number>)?.ep_resolved_return_not ?? "—"} | ${(original.return_items_expected_item_link as Record<string, number>)?.ep_resolved_return_not ?? "—"} |

## product_identifier_map (active)

| Metric | Staging | Original |
|--------|---------|----------|
| Active rows | ${sMap?.active_rows ?? "—"} | ${oMap?.active_rows ?? "—"} |
| With FNSKU | ${sMap?.active_with_fnsku ?? "—"} | ${oMap?.active_with_fnsku ?? "—"} |
| With seller_sku | ${sMap?.active_with_seller_sku ?? "—"} | ${oMap?.active_with_seller_sku ?? "—"} |
| With ASIN | ${sMap?.active_with_asin ?? "—"} | ${oMap?.active_with_asin ?? "—"} |
| With UPC | ${sMap?.active_with_upc ?? "—"} | ${oMap?.active_with_upc ?? "—"} |
| Org-wide (store null) | ${sMap?.active_org_wide_store_null ?? "—"} | ${oMap?.active_org_wide_store_null ?? "—"} |

# UNRESOLVED_TOP_CASES

Top 25 of 100 sampled unresolved \`expected_packages\` on **staging** (full JSON in \`unresolved-top-cases-staging.json\`):

| Class | EP id | Tracking | FNSKU | SKU | Map hits | Product hits | Status |
|-------|-------|----------|-------|-----|----------|--------------|--------|
${topTable || "| — | — | — | — | — | — | — | — |"}

# CLASSIFICATION_COUNTS

Unresolved \`expected_packages\` classified on each ref (+ view F gap on staging/original):

| Class | Meaning | Staging | Original |
|-------|---------|---------|----------|
${(Object.keys(CLASS_LABELS) as ClassKey[])
  .map(
    (k) =>
      `| **${k}** | ${CLASS_LABELS[k]} | ${sClass[k] ?? 0} | ${oClass[k] ?? 0} |`,
  )
  .join("\n")}

**Staging EP breakdown:** ${JSON.stringify(staging.expected_packages_classification)}  
**Original EP breakdown:** ${JSON.stringify(original.expected_packages_classification)}

# STAGING_VS_ORIGINAL_DIFF

| Delta | Value |
|-------|-------|
| expected_packages unresolved (staging − original) | ${stagingVsOriginal.expected_packages_unresolved_delta} |
| expected_packages resolved (staging − original) | ${stagingVsOriginal.expected_packages_resolved_delta} |
| active map rows (staging − original) | ${stagingVsOriginal.map_active_rows_delta} |
| Class A delta | ${stagingVsOriginal.classification.A ?? 0} |
| Class B delta | ${stagingVsOriginal.classification.B ?? 0} |
| Class C delta | ${stagingVsOriginal.classification.C ?? 0} |
| Class D delta | ${stagingVsOriginal.classification.D ?? 0} |
| Class E delta | ${stagingVsOriginal.classification.E ?? 0} |
| Class F delta (view gap) | ${stagingVsOriginal.classification.F ?? 0} |

# SAFE_FIX_ORDER

1. **Class A** — Run governed EP \`resolved_product_id\` backfill from existing \`product_identifier_map\` (map already exists; row not persisted). Lowest risk.
2. **Class B** — Safe map-only inserts where \`products\` row exists for org+store+identifier but map bridge missing. No new products.
3. **Class F** — If EP resolved but view/return row stale: read-path refresh only (views already patched on both refs for spine cols).
4. **Class D** — Manual review queue; do not auto-link ambiguous multi-map / multi-product tiers.
5. **Class E** — Identifier enrichment from slip/OCR/import; no product inference from title.
6. **Class C** — PIM/sheet product seed + map promotion wave; last resort after A/B/E exhausted.

# EXACT_NEXT_PROMPTS

\`\`\`text
EXPECTED-PACKAGES-RESOLVED-BACKFILL-CLASS-A
— Governed UPDATE expected_packages.resolved_product_id from product_identifier_map for Class A rows only (staging first).

PRODUCT-IDENTIFIER-MAP-GAP-BRIDGE-CLASS-B
— Map-only inserts for org+store identifiers where products row exists but map missing.

SLIP-RETURN-LINKAGE-GAP-CENSUS-FOLLOWUP
— Item-level slip_contents + return_items Class A/B/D breakdown mirroring EP logic.

AMBIGUOUS-LINKAGE-REVIEW-QUEUE-CLASS-D
— Export Class D rows for operator review; no auto-link.
\`\`\`
`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!originalUrl) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL unset");

  console.log("Census staging…");
  const staging = await censusRef("staging", STAGING_REF, stagingUrl);
  console.log("Census original…");
  const original = await censusRef("original", ORIGINAL_REF, originalUrl);

  const report = renderReport(runId, staging, original);

  fs.writeFileSync(path.join(outDir, "census-report.md"), report);
  fs.writeFileSync(path.join(outDir, "staging-census.json"), JSON.stringify(staging, null, 2));
  fs.writeFileSync(path.join(outDir, "original-census.json"), JSON.stringify(original, null, 2));
  fs.writeFileSync(
    path.join(outDir, "unresolved-top-cases-staging.json"),
    JSON.stringify(staging.unresolved_top_cases, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "unresolved-top-cases-original.json"),
    JSON.stringify(original.unresolved_top_cases, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit_id: "EXPECTED-PRODUCT-LINKAGE-GAP-CENSUS",
        run_id: runId,
        mode: "read-only",
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        staging_summary: staging.expected_packages,
        original_summary: original.expected_packages,
        staging_classification: staging.classification_counts,
        original_classification: original.classification_counts,
      },
      null,
      2,
    ),
  );

  console.log(report);
  console.log(`\nWrote ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
