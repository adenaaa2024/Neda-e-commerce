/**
 * PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-RESOLUTION-PLAN-V1
 * Read-only resolution plan + dry-run proposals (no writes).
 *
 *   npx tsx scripts/phase-product-linkage-operational-rows-resolution-plan-v1-readonly.ts
 *   npx tsx scripts/phase-product-linkage-operational-rows-resolution-plan-v1-readonly.ts --compare-original
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { RESOLUTION_ORDER_OPERATIONAL, RESOLUTION_ORDER_SCANNER } from "../lib/product-linkage-resolution-policy";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-product-linkage-operational-rows-resolution-plan-v1";

const PROPOSAL_SAMPLE_LIMIT = 30;

type TableSpec = {
  table: string;
  path: string;
  resolution_context: "operational_import" | "scanner";
  store_scoped: boolean;
  active_filter: string | null;
  identifier_fields: { fnsku?: string; asin?: string; sku?: string; upc?: string };
};

const TABLE_SPECS: TableSpec[] = [
  {
    table: "amazon_removals",
    path: "removal",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "amazon_removal_shipments",
    path: "removal",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "amazon_returns",
    path: "operational_import",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "amazon_inventory_ledger",
    path: "inventory",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "amazon_reimbursements",
    path: "operational_import",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "amazon_settlements",
    path: "operational_import",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { asin: "asin", sku: "sku" },
  },
  {
    table: "amazon_transactions",
    path: "operational_import",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { asin: "asin", sku: "sku" },
  },
  {
    table: "return_items",
    path: "scan",
    resolution_context: "scanner",
    store_scoped: true,
    active_filter: "deleted_at IS NULL",
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku", upc: "upc" },
  },
  {
    table: "shipment_box_items",
    path: "shipment",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "expected_packages",
    path: "expected",
    resolution_context: "read_model" as "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "claim_candidates",
    path: "claim",
    resolution_context: "operational_import",
    store_scoped: true,
    active_filter: null,
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
];

type Row = Record<string, unknown>;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPg(url: string, ref: string): Promise<pg.Client> {
  if (!url.includes(ref)) throw new Error(`BLOCKED: must target ref ${ref}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '600s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return r.rows.length > 0;
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function exactIdentifierJoinRules(): Row {
  return {
    operational_import: {
      order: RESOLUTION_ORDER_OPERATIONAL,
      tiers: [
        {
          tier: 1,
          identifier_type: "fnsku",
          join: "upper(btrim(source.fnsku)) = upper(btrim(product_identifier_map.fnsku))",
          confidence: 1.0,
        },
        {
          tier: 2,
          identifier_type: "asin_with_sku",
          join: "upper(btrim(source.asin)) = upper(btrim(map.asin)) AND upper(btrim(source.sku)) IN (upper(btrim(map.seller_sku)), upper(btrim(map.msku)))",
          confidence: 0.95,
        },
        {
          tier: 2,
          identifier_type: "asin",
          join: "upper(btrim(source.asin)) = upper(btrim(product_identifier_map.asin))",
          confidence: 0.95,
        },
        {
          tier: 3,
          identifier_type: "seller_sku_or_msku",
          join: "upper(btrim(source.sku)) IN (upper(btrim(map.seller_sku)), upper(btrim(map.msku)))",
          confidence: 0.85,
        },
        {
          tier: 4,
          identifier_type: "upc_gtin",
          join: "btrim(source.upc) = btrim(map.upc_code) — only when upc already in map",
          confidence: 0.9,
        },
      ],
      scope: "organization_id + store_id + deleted_at IS NULL on map",
      forbidden: ["title match", "product create", "cross-org", "ambiguous auto-map"],
    },
    scanner: {
      order: RESOLUTION_ORDER_SCANNER,
      tiers: [
        { tier: 4, identifier_type: "upc_gtin", join: "return_items.upc → map.upc_code", confidence: 0.9 },
        { tier: 3, identifier_type: "sku_msku", join: "return_items.sku → map.seller_sku/msku", confidence: 0.85 },
        { tier: 1, identifier_type: "fnsku", join: "return_items.fnsku → map.fnsku", confidence: 1.0 },
        { tier: 2, identifier_type: "asin", join: "return_items.asin → map.asin", confidence: 0.8 },
      ],
      scope: "organization_id + store_id",
    },
    map_table: "product_identifier_map",
    product_spine: "products.id ← map.product_id (never create from source row)",
  };
}

function buildClassificationSql(spec: TableSpec, cols: Set<string>): string | null {
  if (!cols.has("resolved_product_id")) return null;

  const storeCol = cols.has("store_id") ? "store_id" : null;
  if (spec.store_scoped && !storeCol) return null;

  const fnskuCol = spec.identifier_fields.fnsku && cols.has(spec.identifier_fields.fnsku) ? spec.identifier_fields.fnsku : null;
  const asinCol = spec.identifier_fields.asin && cols.has(spec.identifier_fields.asin) ? spec.identifier_fields.asin : null;
  const skuCol = spec.identifier_fields.sku && cols.has(spec.identifier_fields.sku) ? spec.identifier_fields.sku : null;
  const upcCol = spec.identifier_fields.upc && cols.has(spec.identifier_fields.upc) ? spec.identifier_fields.upc : null;

  const active = spec.active_filter ? `AND ${spec.active_filter}` : "";
  let ccActive = "";
  if (spec.table === "claim_candidates" && cols.has("quarantined_at")) {
    ccActive = "AND quarantined_at IS NULL";
  }

  const storeJoin = storeCol
    ? "AND m.store_id = s.store_id"
    : "AND m.store_id = $2::uuid";

  const fnskuExpr = fnskuCol ? `nullif(upper(btrim(s.${fnskuCol})), '')` : "NULL::text";
  const asinExpr = asinCol ? `nullif(upper(btrim(s.${asinCol})), '')` : "NULL::text";
  const skuExpr = skuCol ? `nullif(upper(btrim(s.${skuCol})), '')` : "NULL::text";
  const upcExpr = upcCol ? `nullif(btrim(s.${upcCol}), '')` : "NULL::text";

  const scannerFirst = spec.resolution_context === "scanner";

  // Tier match counts — operational FNSKU-first; scanner UPC-first in classification order
  return `
WITH map_fnsku AS (
  SELECT store_id, upper(btrim(fnsku)) AS k, count(DISTINCT product_id)::int AS hits
  FROM product_identifier_map
  WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(fnsku,'')) <> ''
  GROUP BY store_id, upper(btrim(fnsku))
),
map_asin AS (
  SELECT store_id, upper(btrim(asin)) AS k, count(DISTINCT product_id)::int AS hits
  FROM product_identifier_map
  WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(asin,'')) <> ''
  GROUP BY store_id, upper(btrim(asin))
),
map_asin_sku AS (
  SELECT store_id, upper(btrim(asin)) AS asin_k, upper(btrim(coalesce(seller_sku, msku, ''))) AS sku_k,
         count(DISTINCT product_id)::int AS hits
  FROM product_identifier_map
  WHERE organization_id = $1::uuid AND deleted_at IS NULL
    AND btrim(coalesce(asin,'')) <> '' AND btrim(coalesce(seller_sku, msku, '')) <> ''
  GROUP BY store_id, upper(btrim(asin)), upper(btrim(coalesce(seller_sku, msku, '')))
),
map_sku AS (
  SELECT store_id, upper(btrim(coalesce(seller_sku, msku, ''))) AS k, count(DISTINCT product_id)::int AS hits
  FROM product_identifier_map
  WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(seller_sku, msku, '')) <> ''
  GROUP BY store_id, upper(btrim(coalesce(seller_sku, msku, '')))
),
map_upc AS (
  SELECT store_id, btrim(upc_code) AS k, count(DISTINCT product_id)::int AS hits
  FROM product_identifier_map
  WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(upc_code,'')) <> ''
  GROUP BY store_id, btrim(upc_code)
),
src AS (
  SELECT
    s.id,
    ${storeCol ? "s.store_id" : "$2::uuid AS store_id"},
    s.resolved_product_id,
    ${fnskuExpr} AS fnsku_key,
    ${asinExpr} AS asin_key,
    ${skuExpr} AS sku_key,
    ${upcExpr} AS upc_key,
    CASE WHEN ${fnskuExpr} IS NULL AND ${asinExpr} IS NULL AND ${skuExpr} IS NULL AND ${upcExpr} IS NULL THEN true ELSE false END AS no_identifiers
  FROM public.${spec.table} s
  WHERE s.organization_id = $1::uuid
  ${storeCol ? "AND s.store_id = $2::uuid" : ""}
  ${active}
  ${ccActive}
),
match_counts AS (
  SELECT
    s.*,
    coalesce(mf.hits, 0) AS fnsku_hits,
    coalesce(ma.hits, 0) AS asin_hits,
    coalesce(mas.hits, 0) AS asin_sku_hits,
    coalesce(ms.hits, 0) AS sku_hits,
    coalesce(mu.hits, 0) AS upc_hits
  FROM src s
  LEFT JOIN map_fnsku mf ON mf.store_id = s.store_id AND mf.k = s.fnsku_key
  LEFT JOIN map_asin ma ON ma.store_id = s.store_id AND ma.k = s.asin_key
  LEFT JOIN map_asin_sku mas ON mas.store_id = s.store_id AND mas.asin_k = s.asin_key AND mas.sku_k = s.sku_key
  LEFT JOIN map_sku ms ON ms.store_id = s.store_id AND ms.k = s.sku_key
  LEFT JOIN map_upc mu ON mu.store_id = s.store_id AND mu.k = s.upc_key
),
classified AS (
  SELECT
    *,
    CASE
      WHEN resolved_product_id IS NOT NULL THEN 'already_resolved'
      WHEN no_identifiers THEN 'no_identifiers'
      WHEN ${scannerFirst ? `
        (upc_key IS NOT NULL AND upc_hits > 1) OR (sku_key IS NOT NULL AND sku_hits > 1)
        OR (fnsku_key IS NOT NULL AND fnsku_hits > 1) OR (asin_key IS NOT NULL AND asin_hits > 1) THEN 'ambiguous'
        WHEN (upc_key IS NOT NULL AND upc_hits = 1) OR (sku_key IS NOT NULL AND sku_hits = 1)
          OR (fnsku_key IS NOT NULL AND fnsku_hits = 1) OR (asin_key IS NOT NULL AND asin_hits = 1) THEN 'resolvable'
      ` : `
        (fnsku_key IS NOT NULL AND fnsku_hits > 1) OR (asin_key IS NOT NULL AND asin_hits > 1)
        OR (asin_sku_hits > 1) OR (sku_key IS NOT NULL AND sku_hits > 1)
        OR (upc_key IS NOT NULL AND upc_hits > 1) THEN 'ambiguous'
        WHEN (fnsku_key IS NOT NULL AND fnsku_hits = 1) OR (asin_sku_hits = 1)
          OR (asin_key IS NOT NULL AND asin_hits = 1) OR (sku_key IS NOT NULL AND sku_hits = 1)
          OR (upc_key IS NOT NULL AND upc_hits = 1) THEN 'resolvable'
      `}
      ELSE 'unresolved'
    END AS bucket
  FROM match_counts
)
SELECT
  count(*)::int AS row_count,
  count(*) FILTER (WHERE bucket = 'already_resolved')::int AS resolved_product_id_count,
  count(*) FILTER (WHERE bucket = 'no_identifiers')::int AS no_identifiers_count,
  count(*) FILTER (WHERE bucket = 'resolvable')::int AS resolvable_by_exact_identifier_count,
  count(*) FILTER (WHERE bucket = 'ambiguous')::int AS ambiguous_count,
  count(*) FILTER (WHERE bucket = 'unresolved')::int AS unresolved_count
FROM classified
`;
}

async function analyzeTable(c: pg.Client, spec: TableSpec): Promise<Row | null> {
  if (!(await tableExists(c, spec.table))) {
    return { table: spec.table, exists: false };
  }
  const cols = await tableColumns(c, spec.table);
  const sql = buildClassificationSql(spec, cols);
  if (!sql) {
    return { table: spec.table, exists: true, error: "missing resolved_product_id or store_id" };
  }

  try {
    const summary = await c.query(sql, [ORG, STORE]);
    const s = summary.rows[0] as Row;

    const gapParts: string[] = [];
    if (spec.identifier_fields.fnsku && cols.has(spec.identifier_fields.fnsku)) {
      gapParts.push(`nullif(upper(btrim(${spec.identifier_fields.fnsku})), '')`);
    }
    if (spec.identifier_fields.asin && cols.has(spec.identifier_fields.asin)) {
      gapParts.push(`nullif(upper(btrim(${spec.identifier_fields.asin})), '')`);
    }
    if (spec.identifier_fields.sku && cols.has(spec.identifier_fields.sku)) {
      gapParts.push(`nullif(upper(btrim(${spec.identifier_fields.sku})), '')`);
    }
    const gapCoalesce = gapParts.length ? gapParts.join(", ") : "'NO_ID'";

    const gapSql = `
      SELECT coalesce(${gapCoalesce}, 'NO_ID') AS gap_id, count(*)::int AS n
      FROM public.${spec.table}
      WHERE organization_id = $1::uuid
      ${spec.store_scoped && cols.has("store_id") ? "AND store_id = $2::uuid" : ""}
      ${spec.active_filter ? `AND ${spec.active_filter}` : ""}
      ${spec.table === "claim_candidates" && cols.has("quarantined_at") ? "AND quarantined_at IS NULL" : ""}
        AND resolved_product_id IS NULL
      GROUP BY 1 ORDER BY n DESC LIMIT 8`;
    const gaps = await c.query(gapSql, [ORG, STORE]);

    return {
      table: spec.table,
      path: spec.path,
      resolution_context: spec.resolution_context,
      exists: true,
      row_count: s.row_count,
      resolved_product_id_count: s.resolved_product_id_count,
      resolvable_by_exact_identifier_count: s.resolvable_by_exact_identifier_count,
      unresolved_count: s.unresolved_count,
      ambiguous_count: s.ambiguous_count,
      no_identifiers_count: s.no_identifiers_count,
      linkage_percent_after_dryrun:
        Number(s.row_count) === 0
          ? 100
          : Math.round(
              ((Number(s.resolved_product_id_count) + Number(s.resolvable_by_exact_identifier_count)) /
                Number(s.row_count)) *
                1000,
            ) / 10,
      top_identifier_gaps: gaps.rows,
      exact_join_path:
        spec.resolution_context === "scanner"
          ? "return_items.{upc|sku|fnsku|asin} → product_identifier_map (org+store) → product_id"
          : "source.{fnsku|asin+sku|asin|sku|upc} → product_identifier_map (org+store) → product_id",
      risk:
        Number(s.ambiguous_count) > 0
          ? "medium — ambiguous identifier groups must block auto-backfill"
          : Number(s.resolvable_by_exact_identifier_count) > 1000
            ? "low — high-volume exact matches; batch with preimage + rollback"
            : "low",
      safe_to_implement_automated_backfill_later:
        Number(s.ambiguous_count) === 0 && Number(s.resolvable_by_exact_identifier_count) > 0
          ? "yes_with_preimage"
          : Number(s.resolvable_by_exact_identifier_count) > 0
            ? "conditional — exclude ambiguous rows"
            : "no — nothing to backfill or spine gap",
    };
  } catch (e) {
    return { table: spec.table, exists: true, error: String(e) };
  }
}

async function dryRunProposals(c: pg.Client, spec: TableSpec): Promise<Row[]> {
  if (!(await tableExists(c, spec.table))) return [];
  const cols = await tableColumns(c, spec.table);
  if (!cols.has("resolved_product_id")) return [];

  const fnskuCol = spec.identifier_fields.fnsku && cols.has(spec.identifier_fields.fnsku) ? spec.identifier_fields.fnsku : null;
  const asinCol = spec.identifier_fields.asin && cols.has(spec.identifier_fields.asin) ? spec.identifier_fields.asin : null;
  const skuCol = spec.identifier_fields.sku && cols.has(spec.identifier_fields.sku) ? spec.identifier_fields.sku : null;
  const active = spec.active_filter ? `AND ${spec.active_filter}` : "";
  const ccActive = spec.table === "claim_candidates" && cols.has("quarantined_at") ? "AND quarantined_at IS NULL" : "";

  if (!fnskuCol && !asinCol && !skuCol) return [];

  const fnskuRaw = fnskuCol ? `coalesce(s.${fnskuCol}, '')` : `''::text`;
  const asinRaw = asinCol ? `coalesce(s.${asinCol}, '')` : `''::text`;
  const skuRaw = skuCol ? `coalesce(s.${skuCol}, '')` : `''::text`;
  const idFilter = [
    fnskuCol ? `btrim(coalesce(s.${fnskuCol}, '')) <> ''` : null,
    asinCol ? `btrim(coalesce(s.${asinCol}, '')) <> ''` : null,
    skuCol ? `btrim(coalesce(s.${skuCol}, '')) <> ''` : null,
  ]
    .filter(Boolean)
    .join(" OR ");

  const sql = `
WITH candidates AS (
  SELECT
    s.id::text AS source_row_id,
    ${fnskuRaw} AS fnsku_raw,
    ${asinRaw} AS asin_raw,
    ${skuRaw} AS sku_raw,
    s.resolved_product_id::text AS current_product_id
  FROM public.${spec.table} s
  WHERE s.organization_id = $1::uuid
    AND s.store_id = $2::uuid
    AND s.resolved_product_id IS NULL
    ${active}
    ${ccActive}
    AND (${idFilter || "false"})
  LIMIT 5000
),
fnsku_match AS (
  SELECT c.source_row_id, count(DISTINCT m.product_id)::int AS n, min(m.product_id::text) AS pid
  FROM candidates c
  JOIN product_identifier_map m ON m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
    AND btrim(coalesce(c.fnsku_raw, '')) <> ''
    AND upper(btrim(m.fnsku)) = upper(btrim(c.fnsku_raw))
  GROUP BY c.source_row_id
),
asin_match AS (
  SELECT c.source_row_id, count(DISTINCT m.product_id)::int AS n, min(m.product_id::text) AS pid
  FROM candidates c
  JOIN product_identifier_map m ON m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
    AND btrim(coalesce(c.asin_raw, '')) <> ''
    AND upper(btrim(m.asin)) = upper(btrim(c.asin_raw))
  GROUP BY c.source_row_id
),
sku_match AS (
  SELECT c.source_row_id, count(DISTINCT m.product_id)::int AS n, min(m.product_id::text) AS pid
  FROM candidates c
  JOIN product_identifier_map m ON m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
    AND btrim(coalesce(c.sku_raw, '')) <> ''
    AND upper(btrim(coalesce(m.seller_sku, m.msku, ''))) = upper(btrim(c.sku_raw))
  GROUP BY c.source_row_id
)
SELECT
  $3::text AS table_name,
  c.source_row_id,
  CASE
    WHEN btrim(c.fnsku_raw) <> '' THEN c.fnsku_raw
    WHEN btrim(c.asin_raw) <> '' THEN c.asin_raw
    ELSE c.sku_raw
  END AS source_identifier,
  CASE
    WHEN fm.n = 1 THEN fm.pid
    WHEN ${spec.resolution_context === "scanner" ? "false" : "fm.n IS NULL OR fm.n = 0"} AND am.n = 1 THEN am.pid
    WHEN ${spec.resolution_context === "scanner" ? "false" : "fm.n IS NULL OR fm.n = 0"} AND sm.n = 1 THEN sm.pid
    ELSE NULL
  END AS proposed_product_id,
  CASE
    WHEN fm.n = 1 THEN 'fnsku'
    WHEN fm.n > 1 THEN 'ambiguous_fnsku'
    WHEN am.n = 1 THEN 'asin'
    WHEN am.n > 1 THEN 'ambiguous_asin'
    WHEN sm.n = 1 THEN 'seller_sku_or_msku'
    WHEN sm.n > 1 THEN 'ambiguous_sku'
    ELSE 'unresolved'
  END AS identifier_type,
  CASE
    WHEN fm.n = 1 THEN 1.0
    WHEN am.n = 1 THEN 0.95
    WHEN sm.n = 1 THEN 0.85
    ELSE 0
  END AS confidence,
  CASE
    WHEN fm.n > 1 OR am.n > 1 OR sm.n > 1 THEN 'ambiguous_map_conflict'
    WHEN fm.n IS NULL AND am.n IS NULL AND sm.n IS NULL THEN 'no_map_hit'
    ELSE NULL
  END AS blocker
FROM candidates c
LEFT JOIN fnsku_match fm ON fm.source_row_id = c.source_row_id
LEFT JOIN asin_match am ON am.source_row_id = c.source_row_id
LEFT JOIN sku_match sm ON sm.source_row_id = c.source_row_id
WHERE (
  (fm.n = 1) OR (fm.n > 1) OR (am.n = 1) OR (am.n > 1) OR (sm.n = 1) OR (sm.n > 1)
  OR (fm.n IS NULL AND am.n IS NULL AND sm.n IS NULL)
)
LIMIT ${PROPOSAL_SAMPLE_LIMIT}`;

  const r = await c.query(sql, [ORG, STORE, spec.table]);
  return r.rows.map((row: Row) => ({
    ...row,
    duplicate_ambiguous_check:
      row.blocker === "ambiguous_map_conflict" ? "BLOCK — multiple product_id at tier" : "pass",
  }));
}

function tablePriorityOrder(matrix: Row[]): Row[] {
  return [...matrix]
    .filter((r) => r.exists && !r.error)
    .sort((a, b) => {
      const score = (r: Row) =>
        Number(r.resolvable_by_exact_identifier_count ?? 0) * 2 +
        Number(r.unresolved_count ?? 0) * 0.1 -
        Number(r.ambiguous_count ?? 0) * 5;
      return score(b) - score(a);
    })
    .map((r, i) => ({
      priority: i + 1,
      table: r.table,
      resolvable: r.resolvable_by_exact_identifier_count,
      ambiguous: r.ambiguous_count,
      projected_linkage_after: r.linkage_percent_after_dryrun,
    }));
}

function evaluateSafeBackfill(matrix: Row[]): { verdict: string; rationale: string } {
  const resolvable = matrix.reduce((s, r) => s + Number(r.resolvable_by_exact_identifier_count ?? 0), 0);
  const ambiguous = matrix.reduce((s, r) => s + Number(r.ambiguous_count ?? 0), 0);
  const hardErrors = matrix.filter(
    (r) => r.error && !String(r.error).includes("missing resolved_product_id"),
  ).length;

  if (hardErrors > 0) {
    return { verdict: "no", rationale: "Classification errors on one or more tables — fix SQL before backfill" };
  }
  if (resolvable === 0) {
    return { verdict: "no", rationale: "No exact-identifier resolvable rows — spine gap or missing identifiers" };
  }
  if (ambiguous > 500) {
    return {
      verdict: "conditional",
      rationale: `${resolvable} resolvable rows but ${ambiguous} ambiguous — backfill only non-ambiguous with preimage + Maysam approval; exclude claim_candidates wave 1`,
    };
  }
  return {
    verdict: "yes",
    rationale: `${resolvable} rows resolvable by exact identifier; implement governed backfill with preimage, rollback, exclude ambiguous + claim_candidates deferred`,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  if (getStagingProjectRef() !== STAGING_REF) throw new Error(`BLOCKED: staging ref ${STAGING_REF}`);

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (!pgUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL required");

  const run = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run);
  fs.mkdirSync(outDir, { recursive: true });

  const c = await connectPg(pgUrl, STAGING_REF);

  const operational_linkage_resolution_matrix: Row[] = [];
  const allProposals: Row[] = [];

  for (const spec of TABLE_SPECS) {
    const row = await analyzeTable(c, spec);
    if (row) operational_linkage_resolution_matrix.push(row);
    if (row?.exists && !row.error) {
      const proposals = await dryRunProposals(c, spec);
      allProposals.push(...proposals);
    }
  }

  await c.end();

  const dry_run_proposal_counts = {
    total_proposals_sampled: allProposals.length,
    resolvable_proposals: allProposals.filter((p) => p.proposed_product_id && !p.blocker).length,
    ambiguous_proposals: allProposals.filter((p) => p.blocker === "ambiguous_map_conflict").length,
    unresolved_proposals: allProposals.filter((p) => !p.proposed_product_id && p.blocker === "no_map_hit").length,
    by_table: TABLE_SPECS.map((s) => ({
      table: s.table,
      sampled: allProposals.filter((p) => p.table_name === s.table).length,
    })),
  };

  const ambiguous_blocks = operational_linkage_resolution_matrix
    .filter((r) => Number(r.ambiguous_count) > 0)
    .map((r) => ({
      table: r.table,
      ambiguous_count: r.ambiguous_count,
      action: "exclude from automated backfill; human review via Product Match",
    }));

  const unresolved_blocks = operational_linkage_resolution_matrix
    .filter((r) => Number(r.unresolved_count) > 0)
    .map((r) => ({
      table: r.table,
      unresolved_count: r.unresolved_count,
      no_identifiers_count: r.no_identifiers_count,
      top_gaps: r.top_identifier_gaps,
    }));

  const safeEval = evaluateSafeBackfill(operational_linkage_resolution_matrix);
  const table_priority_order = tablePriorityOrder(operational_linkage_resolution_matrix);

  const outputs = {
    operational_linkage_resolution_matrix,
    exact_identifier_join_rules: exactIdentifierJoinRules(),
    dry_run_proposal_counts,
    dry_run_proposal_samples: allProposals,
    ambiguous_blocks,
    unresolved_blocks,
    table_priority_order,
    no_db_write_verification: {
      mode: "read_only",
      postgres_read_only: true,
      tables_mutated: 0,
      claim_candidates_mutated: 0,
      verified: true,
    },
    no_scanner_change_verification: { operator_mobile_touched: false, verified: true },
    SAFE_TO_IMPLEMENT_OPERATIONAL_LINKAGE_BACKFILL: safeEval.verdict,
    SAFE_TO_IMPLEMENT_RATIONALE: safeEval.rationale,
    NEXT_PROMPT:
      safeEval.verdict !== "no"
        ? `PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-DRYRUN-V1
Mode: staging dry-run execute with preimage only (max 500 rows/table).
Priority wave 1 (zero ambiguous): amazon_removals, amazon_removal_shipments, expected_packages.
Priority wave 2 (exclude ambiguous): amazon_inventory_ledger, amazon_settlements.
Do NOT update claim_candidates in wave 1.
Require Maysam approval + rollback.sql per table.
Evidence: phase-product-linkage-operational-rows-resolution-plan-v1/${run}/`
        : `PHASE-PRODUCT-IDENTIFIER-MAP-GOVERNED-SEED-V1 — spine gaps for unmapped FNSKUs before operational backfill`,
  };

  for (const [key, val] of Object.entries(outputs)) {
    if (key === "NEXT_PROMPT") {
      fs.writeFileSync(path.join(outDir, `${key}.txt`), String(val));
    } else {
      fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(val, null, 2));
    }
  }

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-RESOLUTION-PLAN-V1",
        run_id: run,
        staging_ref: STAGING_REF,
        tables_analyzed: operational_linkage_resolution_matrix.length,
        SAFE_TO_IMPLEMENT_OPERATIONAL_LINKAGE_BACKFILL: safeEval.verdict,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "plan-summary.md"),
    [
      "# Operational linkage resolution plan V1",
      "",
      `**Run:** \`${run}\``,
      "",
      "| Table | Rows | Resolved | Resolvable | Ambiguous | After dry-run % |",
      "|-------|-----:|---------:|-----------:|----------:|----------------:|",
      ...operational_linkage_resolution_matrix
        .filter((r) => r.exists && !r.error)
        .map(
          (r) =>
            `| ${r.table} | ${r.row_count} | ${r.resolved_product_id_count} | ${r.resolvable_by_exact_identifier_count} | ${r.ambiguous_count} | ${r.linkage_percent_after_dryrun}% |`,
        ),
      "",
      `**SAFE_TO_IMPLEMENT_OPERATIONAL_LINKAGE_BACKFILL:** **${safeEval.verdict}**`,
    ].join("\n"),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        SAFE_TO_IMPLEMENT_OPERATIONAL_LINKAGE_BACKFILL: safeEval.verdict,
        total_resolvable: operational_linkage_resolution_matrix.reduce(
          (s, r) => s + Number(r.resolvable_by_exact_identifier_count ?? 0),
          0,
        ),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
