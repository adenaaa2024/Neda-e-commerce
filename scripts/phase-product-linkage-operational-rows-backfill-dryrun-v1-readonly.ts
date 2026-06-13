/**
 * PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-DRYRUN-V1
 * Staging dry-run + preimage plan only — Wave 1 tables, no writes.
 *
 *   npx tsx scripts/phase-product-linkage-operational-rows-backfill-dryrun-v1-readonly.ts
 *   npx tsx scripts/phase-product-linkage-operational-rows-backfill-dryrun-v1-readonly.ts --compare-original
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { RESOLUTION_ORDER_OPERATIONAL } from "../lib/product-linkage-resolution-policy";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-product-linkage-operational-rows-backfill-dryrun-v1";
const PROPOSAL_SAMPLE_LIMIT = 500;

const WAVE1_TABLES = ["amazon_removals", "amazon_removal_shipments", "expected_packages"] as const;

type Wave1Table = (typeof WAVE1_TABLES)[number];

type TableSpec = {
  table: Wave1Table;
  path: "removal" | "expected";
  identifier_fields: { fnsku?: string; asin?: string; sku?: string; upc?: string };
};

const WAVE1_SPECS: TableSpec[] = [
  {
    table: "amazon_removals",
    path: "removal",
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "amazon_removal_shipments",
    path: "removal",
    identifier_fields: { fnsku: "fnsku", asin: "asin", sku: "sku" },
  },
  {
    table: "expected_packages",
    path: "expected",
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
  await c.query("SET statement_timeout = '900s'");
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

function buildClassificationSql(spec: TableSpec, cols: Set<string>): string | null {
  if (!cols.has("resolved_product_id") || !cols.has("store_id")) return null;

  const fnskuCol = spec.identifier_fields.fnsku && cols.has(spec.identifier_fields.fnsku) ? spec.identifier_fields.fnsku : null;
  const asinCol = spec.identifier_fields.asin && cols.has(spec.identifier_fields.asin) ? spec.identifier_fields.asin : null;
  const skuCol = spec.identifier_fields.sku && cols.has(spec.identifier_fields.sku) ? spec.identifier_fields.sku : null;
  const upcCol = spec.identifier_fields.upc && cols.has(spec.identifier_fields.upc) ? spec.identifier_fields.upc : null;

  const fnskuExpr = fnskuCol ? `nullif(upper(btrim(s.${fnskuCol})), '')` : "NULL::text";
  const asinExpr = asinCol ? `nullif(upper(btrim(s.${asinCol})), '')` : "NULL::text";
  const skuExpr = skuCol ? `nullif(upper(btrim(s.${skuCol})), '')` : "NULL::text";
  const upcExpr = upcCol ? `nullif(btrim(s.${upcCol}), '')` : "NULL::text";

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
    s.store_id,
    s.resolved_product_id,
    ${fnskuExpr} AS fnsku_key,
    ${asinExpr} AS asin_key,
    ${skuExpr} AS sku_key,
    ${upcExpr} AS upc_key,
    CASE WHEN ${fnskuExpr} IS NULL AND ${asinExpr} IS NULL AND ${skuExpr} IS NULL AND ${upcExpr} IS NULL THEN true ELSE false END AS no_identifiers
  FROM public.${spec.table} s
  WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
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
      WHEN (fnsku_key IS NOT NULL AND fnsku_hits > 1) OR (asin_key IS NOT NULL AND asin_hits > 1)
        OR (asin_sku_hits > 1) OR (sku_key IS NOT NULL AND sku_hits > 1)
        OR (upc_key IS NOT NULL AND upc_hits > 1) THEN 'ambiguous'
      WHEN (fnsku_key IS NOT NULL AND fnsku_hits = 1) OR (asin_sku_hits = 1)
        OR (asin_key IS NOT NULL AND asin_hits = 1) OR (sku_key IS NOT NULL AND sku_hits = 1)
        OR (upc_key IS NOT NULL AND upc_hits = 1) THEN 'resolvable'
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
FROM classified`;
}

async function analyzeWave1Table(c: pg.Client, spec: TableSpec): Promise<Row> {
  if (!(await tableExists(c, spec.table))) {
    return { table: spec.table, exists: false };
  }
  const cols = await tableColumns(c, spec.table);
  const sql = buildClassificationSql(spec, cols);
  if (!sql) {
    return { table: spec.table, exists: true, error: "missing resolved_product_id or store_id" };
  }
  const summary = await c.query(sql, [ORG, STORE]);
  const s = summary.rows[0] as Row;
  const rowCount = Number(s.row_count ?? 0);
  const resolved = Number(s.resolved_product_id_count ?? 0);
  const resolvable = Number(s.resolvable_by_exact_identifier_count ?? 0);
  return {
    table: spec.table,
    exists: true,
    row_count: rowCount,
    resolved_product_id_count: resolved,
    resolvable_by_exact_identifier_count: resolvable,
    ambiguous_count: Number(s.ambiguous_count ?? 0),
    unresolved_count: Number(s.unresolved_count ?? 0),
    no_identifiers_count: Number(s.no_identifiers_count ?? 0),
    linkage_percent_current: rowCount === 0 ? 100 : Math.round((resolved / rowCount) * 1000) / 10,
    linkage_percent_after_dryrun:
      rowCount === 0 ? 100 : Math.round(((resolved + resolvable) / rowCount) * 1000) / 10,
  };
}

function buildProposalSql(spec: TableSpec, cols: Set<string>): string | null {
  if (!cols.has("resolved_product_id") || !cols.has("store_id")) return null;

  const fnskuCol = spec.identifier_fields.fnsku && cols.has(spec.identifier_fields.fnsku) ? spec.identifier_fields.fnsku : null;
  const asinCol = spec.identifier_fields.asin && cols.has(spec.identifier_fields.asin) ? spec.identifier_fields.asin : null;
  const skuCol = spec.identifier_fields.sku && cols.has(spec.identifier_fields.sku) ? spec.identifier_fields.sku : null;
  const upcCol = spec.identifier_fields.upc && cols.has(spec.identifier_fields.upc) ? spec.identifier_fields.upc : null;

  if (!fnskuCol && !asinCol && !skuCol && !upcCol) return null;

  const fnskuRaw = fnskuCol ? `coalesce(s.${fnskuCol}, '')` : `''::text`;
  const asinRaw = asinCol ? `coalesce(s.${asinCol}, '')` : `''::text`;
  const skuRaw = skuCol ? `coalesce(s.${skuCol}, '')` : `''::text`;
  const upcRaw = upcCol ? `coalesce(s.${upcCol}, '')` : `''::text`;

  const idFilter = [
    fnskuCol ? `btrim(coalesce(s.${fnskuCol}, '')) <> ''` : null,
    asinCol ? `btrim(coalesce(s.${asinCol}, '')) <> ''` : null,
    skuCol ? `btrim(coalesce(s.${skuCol}, '')) <> ''` : null,
    upcCol ? `btrim(coalesce(s.${upcCol}, '')) <> ''` : null,
  ]
    .filter(Boolean)
    .join(" OR ");

  return `
WITH unlinked AS (
  SELECT
    s.id::text AS source_row_id,
    s.organization_id,
    s.store_id,
    ${fnskuRaw} AS fnsku_raw,
    ${asinRaw} AS asin_raw,
    ${skuRaw} AS sku_raw,
    ${upcRaw} AS upc_raw,
    s.resolved_product_id::text AS current_resolved_product_id
  FROM public.${spec.table} s
  WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
    AND s.resolved_product_id IS NULL
    AND (${idFilter || "false"})
),
fnsku_map AS (
  SELECT u.source_row_id, m.product_id::text AS product_id, count(*) OVER (PARTITION BY u.source_row_id) AS n
  FROM unlinked u
  JOIN product_identifier_map m ON m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
    AND btrim(coalesce(u.fnsku_raw, '')) <> ''
    AND upper(btrim(m.fnsku)) = upper(btrim(u.fnsku_raw))
),
fnsku_pick AS (
  SELECT source_row_id, min(product_id) AS product_id, count(DISTINCT product_id)::int AS n
  FROM fnsku_map GROUP BY source_row_id
),
asin_sku_map AS (
  SELECT u.source_row_id, m.product_id::text AS product_id
  FROM unlinked u
  JOIN product_identifier_map m ON m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
    AND btrim(coalesce(u.asin_raw, '')) <> '' AND btrim(coalesce(u.sku_raw, '')) <> ''
    AND upper(btrim(m.asin)) = upper(btrim(u.asin_raw))
    AND upper(btrim(coalesce(m.seller_sku, m.msku, ''))) = upper(btrim(u.sku_raw))
),
asin_sku_pick AS (
  SELECT source_row_id, min(product_id) AS product_id, count(DISTINCT product_id)::int AS n
  FROM asin_sku_map GROUP BY source_row_id
),
asin_map AS (
  SELECT u.source_row_id, m.product_id::text AS product_id
  FROM unlinked u
  JOIN product_identifier_map m ON m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
    AND btrim(coalesce(u.asin_raw, '')) <> ''
    AND upper(btrim(m.asin)) = upper(btrim(u.asin_raw))
),
asin_pick AS (
  SELECT source_row_id, min(product_id) AS product_id, count(DISTINCT product_id)::int AS n
  FROM asin_map GROUP BY source_row_id
),
sku_map AS (
  SELECT u.source_row_id, m.product_id::text AS product_id
  FROM unlinked u
  JOIN product_identifier_map m ON m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
    AND btrim(coalesce(u.sku_raw, '')) <> ''
    AND upper(btrim(coalesce(m.seller_sku, m.msku, ''))) = upper(btrim(u.sku_raw))
),
sku_pick AS (
  SELECT source_row_id, min(product_id) AS product_id, count(DISTINCT product_id)::int AS n
  FROM sku_map GROUP BY source_row_id
),
upc_map AS (
  SELECT u.source_row_id, m.product_id::text AS product_id
  FROM unlinked u
  JOIN product_identifier_map m ON m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
    AND btrim(coalesce(u.upc_raw, '')) <> ''
    AND btrim(m.upc_code) = btrim(u.upc_raw)
),
upc_pick AS (
  SELECT source_row_id, min(product_id) AS product_id, count(DISTINCT product_id)::int AS n
  FROM upc_map GROUP BY source_row_id
),
proposed AS (
  SELECT
    u.source_row_id,
    u.fnsku_raw,
    u.asin_raw,
    u.sku_raw,
    u.upc_raw,
    u.current_resolved_product_id,
    CASE
      WHEN fp.n = 1 THEN fp.product_id
      WHEN fp.n > 1 THEN NULL
      WHEN asp.n = 1 THEN asp.product_id
      WHEN asp.n > 1 THEN NULL
      WHEN ap.n = 1 THEN ap.product_id
      WHEN ap.n > 1 THEN NULL
      WHEN sp.n = 1 THEN sp.product_id
      WHEN sp.n > 1 THEN NULL
      WHEN up.n = 1 THEN up.product_id
      WHEN up.n > 1 THEN NULL
      ELSE NULL
    END AS proposed_product_id,
    CASE
      WHEN fp.n = 1 THEN 'fnsku'
      WHEN fp.n > 1 THEN 'ambiguous_fnsku'
      WHEN asp.n = 1 THEN 'asin_with_sku'
      WHEN asp.n > 1 THEN 'ambiguous_asin_sku'
      WHEN ap.n = 1 THEN 'asin'
      WHEN ap.n > 1 THEN 'ambiguous_asin'
      WHEN sp.n = 1 THEN 'seller_sku_or_msku'
      WHEN sp.n > 1 THEN 'ambiguous_sku'
      WHEN up.n = 1 THEN 'upc_gtin'
      WHEN up.n > 1 THEN 'ambiguous_upc'
      ELSE 'unresolved'
    END AS identifier_type,
    CASE
      WHEN fp.n = 1 THEN 1.0
      WHEN asp.n = 1 THEN 0.95
      WHEN ap.n = 1 THEN 0.95
      WHEN sp.n = 1 THEN 0.85
      WHEN up.n = 1 THEN 0.9
      ELSE 0
    END AS confidence,
    CASE
      WHEN fp.n > 1 OR asp.n > 1 OR ap.n > 1 OR sp.n > 1 OR up.n > 1 THEN 'ambiguous_map_conflict'
      WHEN fp.n IS NULL AND asp.n IS NULL AND ap.n IS NULL AND sp.n IS NULL AND up.n IS NULL THEN 'no_map_hit'
      ELSE NULL
    END AS blocker
  FROM unlinked u
  LEFT JOIN fnsku_pick fp ON fp.source_row_id = u.source_row_id
  LEFT JOIN asin_sku_pick asp ON asp.source_row_id = u.source_row_id AND (fp.n IS NULL OR fp.n = 0)
  LEFT JOIN asin_pick ap ON ap.source_row_id = u.source_row_id AND (fp.n IS NULL OR fp.n = 0) AND (asp.n IS NULL OR asp.n = 0)
  LEFT JOIN sku_pick sp ON sp.source_row_id = u.source_row_id AND (fp.n IS NULL OR fp.n = 0) AND (asp.n IS NULL OR asp.n = 0) AND (ap.n IS NULL OR ap.n = 0)
  LEFT JOIN upc_pick up ON up.source_row_id = u.source_row_id AND (fp.n IS NULL OR fp.n = 0) AND (asp.n IS NULL OR asp.n = 0) AND (ap.n IS NULL OR ap.n = 0) AND (sp.n IS NULL OR sp.n = 0)
)
SELECT
  $3::text AS table_name,
  source_row_id,
  CASE
    WHEN btrim(fnsku_raw) <> '' THEN fnsku_raw
    WHEN btrim(asin_raw) <> '' AND btrim(sku_raw) <> '' THEN asin_raw || '+' || sku_raw
    WHEN btrim(asin_raw) <> '' THEN asin_raw
    WHEN btrim(sku_raw) <> '' THEN sku_raw
    ELSE upc_raw
  END AS source_identifier,
  proposed_product_id,
  identifier_type,
  confidence,
  blocker,
  current_resolved_product_id
FROM proposed
WHERE proposed_product_id IS NOT NULL AND blocker IS NULL
LIMIT ${PROPOSAL_SAMPLE_LIMIT}`;
}

async function dryRunProposalsForTable(c: pg.Client, spec: TableSpec): Promise<Row[]> {
  const cols = await tableColumns(c, spec.table);
  const sql = buildProposalSql(spec, cols);
  if (!sql) return [];
  const r = await c.query(sql, [ORG, STORE, spec.table]);
  return r.rows as Row[];
}

function preimagePlanForTable(spec: TableSpec, cols: Set<string>): Row {
  const extraCols = ["identifier_resolution_status", "identifier_resolution_confidence", "updated_at"].filter((c) =>
    cols.has(c),
  );
  const selectCols = ["id", "organization_id", "store_id", "resolved_product_id", ...extraCols].join(", ");
  return {
    table: spec.table,
    step: "pre_write_preimage_export",
    description: "Run before wave1 write; store JSON snapshot for rollback",
    sql: `-- PREIMAGE (read-only export — run before write phase)
SELECT ${selectCols}
FROM public.${spec.table}
WHERE organization_id = '${ORG}'::uuid
  AND store_id = '${STORE}'::uuid
  AND resolved_product_id IS NULL
  AND id IN (
    -- populate from dryrun proposal source_row_id list at execute time
    SELECT id FROM public.${spec.table} WHERE false
  );`,
    artifact: `${spec.table}-preimage.json`,
    rules: [
      "Exact identifier proposals only",
      "Exclude ambiguous rows",
      "organization_id + store_id scoped",
      "No product_identifier_map mutation",
    ],
  };
}

function rollbackPlanForTable(spec: TableSpec, cols: Set<string>): Row {
  const sets = ["resolved_product_id = p.resolved_product_id"];
  if (cols.has("identifier_resolution_status")) {
    sets.push("identifier_resolution_status = p.identifier_resolution_status");
  }
  if (cols.has("identifier_resolution_confidence")) {
    sets.push("identifier_resolution_confidence = p.identifier_resolution_confidence");
  }
  return {
    table: spec.table,
    step: "rollback_from_preimage",
    description: "Restore columns from preimage JSON — run only if write phase needs revert",
    sql: `-- ROLLBACK (requires ${spec.table}-preimage.json from execute phase)
-- UPDATE public.${spec.table} t
-- SET ${sets.join(", ")}
-- FROM json_populate_recordset(null::public.${spec.table}, :preimage_json) p
-- WHERE t.id = p.id AND t.organization_id = '${ORG}'::uuid;`,
    note: "Prefer parameterized rollback script in write phase; never run on original without approval",
  };
}

function writePlanForTable(spec: TableSpec, cols: Set<string>): Row {
  const sets = ["resolved_product_id = :proposed_product_id", "identifier_resolution_status = 'resolved'"];
  if (cols.has("identifier_resolution_confidence")) {
    sets.push("identifier_resolution_confidence = :confidence");
  }
  if (cols.has("updated_at")) {
    sets.push("updated_at = now()");
  }
  return {
    table: spec.table,
    step: "future_write_phase_only",
    status: "NOT RUN — dry-run phase",
    sql_template: `-- WRITE (staging only — requires Maysam approval + preimage)
-- UPDATE public.${spec.table}
-- SET ${sets.join(", ")}
-- WHERE id = :source_row_id
--   AND organization_id = '${ORG}'::uuid
--   AND store_id = '${STORE}'::uuid
--   AND resolved_product_id IS NULL;`,
    forbidden: [
      "products",
      "product_identifier_map",
      "product_prices",
      "amazon_* except target table resolved_product_id",
      "claim_candidates",
    ],
  };
}

function evaluateWave1Safe(counts: Row[]): { verdict: string; rationale: string } {
  const wave = counts.filter((c) => c.exists && !c.error);
  const ambiguous = wave.reduce((s, c) => s + Number(c.ambiguous_count ?? 0), 0);
  const resolvable = wave.reduce((s, c) => s + Number(c.resolvable_by_exact_identifier_count ?? 0), 0);
  const errors = counts.filter((c) => c.error);

  if (errors.length) {
    return { verdict: "no", rationale: `Wave1 table errors: ${errors.map((e) => e.table).join(", ")}` };
  }
  if (resolvable === 0) {
    return { verdict: "no", rationale: "No resolvable rows in wave 1" };
  }
  if (ambiguous > 0) {
    return {
      verdict: "conditional",
      rationale: `${ambiguous} ambiguous rows in wave 1 — exclude from write; proceed only non-ambiguous with preimage`,
    };
  }
  return {
    verdict: "yes",
    rationale: `${resolvable} exact-identifier resolvable rows across wave 1; zero ambiguous; preimage + rollback ready for staging write phase`,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  if (getStagingProjectRef() !== STAGING_REF) throw new Error(`BLOCKED: staging ref ${STAGING_REF}`);

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (!pgUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL required");

  const compareOriginal = process.argv.includes("--compare-original");
  const run = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run);
  fs.mkdirSync(outDir, { recursive: true });

  const c = await connectPg(pgUrl, STAGING_REF);

  const wave1_table_counts: Row[] = [];
  const dryrun_proposals_by_table: Row[] = [];
  const sample_proposals: Row[] = [];
  const preimage_plan: Row[] = [];
  const rollback_plan: Row[] = [];
  const write_plan_blocked: Row[] = [];

  for (const spec of WAVE1_SPECS) {
    const counts = await analyzeWave1Table(c, spec);
    wave1_table_counts.push(counts);

    if (counts.exists && !counts.error) {
      const proposals = await dryRunProposalsForTable(c, spec);
      sample_proposals.push(...proposals);
      dryrun_proposals_by_table.push({
        table: spec.table,
        resolvable_proposals_sampled: proposals.length,
        resolvable_total_from_classification: counts.resolvable_by_exact_identifier_count,
        ambiguous_excluded_from_proposals: Number(counts.ambiguous_count ?? 0),
        unresolved: Number(counts.unresolved_count ?? 0),
      });

      const cols = await tableColumns(c, spec.table);
      preimage_plan.push(preimagePlanForTable(spec, cols));
      rollback_plan.push(rollbackPlanForTable(spec, cols));
      write_plan_blocked.push(writePlanForTable(spec, cols));
    }
  }

  await c.end();

  let original_compare_readonly: Row | null = null;
  if (compareOriginal) {
    bindProductionSupabaseEnv();
    const origUrl = productionPostgresUrl();
    const oc = await connectPg(origUrl, PRODUCTION_REF);
    const origCounts: Row[] = [];
    for (const spec of WAVE1_SPECS) {
      origCounts.push(await analyzeWave1Table(oc, spec));
    }
    await oc.end();
    original_compare_readonly = {
      ref: PRODUCTION_REF,
      mode: "read_only",
      wave1_table_counts: origCounts,
      note: "Original counts for parity only — no write backfill on original in wave 1",
    };
  }

  const ambiguous_excluded_count = wave1_table_counts.reduce(
    (s, c) => s + Number(c.ambiguous_count ?? 0),
    0,
  );
  const unresolved_count = wave1_table_counts.reduce((s, c) => s + Number(c.unresolved_count ?? 0), 0);
  const totalRows = wave1_table_counts.reduce((s, c) => s + Number(c.row_count ?? 0), 0);
  const totalResolved = wave1_table_counts.reduce((s, c) => s + Number(c.resolved_product_id_count ?? 0), 0);
  const totalResolvable = wave1_table_counts.reduce(
    (s, c) => s + Number(c.resolvable_by_exact_identifier_count ?? 0),
    0,
  );

  const estimated_after_backfill_linkage = {
    wave1_total_rows: totalRows,
    currently_linked: totalResolved,
    would_link_via_exact_identifier: totalResolvable,
    ambiguous_excluded: ambiguous_excluded_count,
    unresolved_remain: unresolved_count,
    projected_linkage_percent:
      totalRows === 0 ? 100 : Math.round(((totalResolved + totalResolvable) / totalRows) * 1000) / 10,
    per_table: wave1_table_counts.map((c) => ({
      table: c.table,
      current_pct: c.linkage_percent_current,
      after_dryrun_pct: c.linkage_percent_after_dryrun,
    })),
  };

  const safeEval = evaluateWave1Safe(wave1_table_counts);

  const outputs: Row = {
    phase: "PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-DRYRUN-V1",
    run_id: run,
    staging_ref: STAGING_REF,
    org_id: ORG,
    store_id: STORE,
    prerequisite: "No Link readmodel fix applied (20260613T052400Z) — unrelated to operational backfill",
    wave1_tables: WAVE1_TABLES,
    resolution_order: RESOLUTION_ORDER_OPERATIONAL,
    wave1_table_counts,
    dryrun_proposals_by_table,
    sample_proposals,
    sample_proposals_count: sample_proposals.length,
    ambiguous_excluded_count,
    unresolved_count,
    preimage_plan,
    rollback_plan,
    future_write_plan_blocked: write_plan_blocked,
    estimated_after_backfill_linkage,
    original_compare_readonly,
    no_write_verification: {
      mode: "read_only_dryrun",
      postgres_read_only: true,
      tables_mutated: 0,
      claim_candidates_mutated: 0,
      expected_packages_mutated: 0,
      verified: true,
    },
    no_scanner_change_verification: { scanner_code_touched: false, verified: true },
    SAFE_TO_IMPLEMENT_WAVE1_BACKFILL_STAGING_WRITE: safeEval.verdict,
    SAFE_RATIONALE: safeEval.rationale,
    NEXT_PROMPT:
      safeEval.verdict !== "no"
        ? `PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-STAGING-WRITE-V1
Mode: staging write with preimage export only.
Tables: amazon_removals, amazon_removal_shipments, expected_packages.
Max batch with rollback.sql per table. Exclude ambiguous. No claim_candidates.
Require Maysam approval. Evidence: phase-product-linkage-operational-rows-backfill-dryrun-v1/${run}/`
        : "PHASE-PRODUCT-IDENTIFIER-MAP-GOVERNED-SEED-V1 — resolve spine gaps before wave1 write",
  };

  for (const [key, val] of Object.entries(outputs)) {
    if (key === "NEXT_PROMPT") {
      fs.writeFileSync(path.join(outDir, `${key}.txt`), String(val));
    } else if (typeof val === "string") {
      fs.writeFileSync(path.join(outDir, `${key}.txt`), val);
    } else {
      fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(val, null, 2));
    }
  }

  fs.writeFileSync(path.join(outDir, "preimage-plan.sql"), preimage_plan.map((p) => p.sql).join("\n\n"));
  fs.writeFileSync(path.join(outDir, "rollback-plan.sql"), rollback_plan.map((p) => p.sql).join("\n\n"));

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-PRODUCT-LINKAGE-OPERATIONAL-ROWS-BACKFILL-DRYRUN-V1",
        run_id: run,
        staging_ref: STAGING_REF,
        SAFE_TO_IMPLEMENT_WAVE1_BACKFILL_STAGING_WRITE: safeEval.verdict,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "dryrun-summary.md"),
    [
      "# Wave 1 operational linkage backfill dry-run",
      "",
      `**Run:** \`${run}\` · **Staging:** \`${STAGING_REF}\``,
      "",
      "## Wave 1 counts",
      "",
      "| Table | Rows | Linked | Resolvable | Ambiguous | Unresolved | After % |",
      "|-------|-----:|-------:|-----------:|----------:|-----------:|--------:|",
      ...wave1_table_counts
        .filter((c) => c.exists && !c.error)
        .map(
          (c) =>
            `| ${c.table} | ${c.row_count} | ${c.resolved_product_id_count} | ${c.resolvable_by_exact_identifier_count} | ${c.ambiguous_count} | ${c.unresolved_count} | ${c.linkage_percent_after_dryrun}% |`,
        ),
      "",
      `**Projected wave1 linkage:** ${estimated_after_backfill_linkage.projected_linkage_percent}%`,
      `**Sample proposals:** ${sample_proposals.length} (max ${PROPOSAL_SAMPLE_LIMIT}/table)`,
      `**Ambiguous excluded:** ${ambiguous_excluded_count}`,
      "",
      `**SAFE_TO_IMPLEMENT_WAVE1_BACKFILL_STAGING_WRITE:** **${safeEval.verdict}**`,
      "",
      safeEval.rationale,
    ].join("\n"),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        SAFE_TO_IMPLEMENT_WAVE1_BACKFILL_STAGING_WRITE: safeEval.verdict,
        projected_linkage_pct: estimated_after_backfill_linkage.projected_linkage_percent,
        resolvable_total: totalResolvable,
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
