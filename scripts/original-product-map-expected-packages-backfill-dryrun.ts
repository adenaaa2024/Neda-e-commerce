/**
 * ORIGINAL-PRODUCT-MAP-EXPECTED-PACKAGES-BACKFILL-DRYRUN (read-only)
 *   npx tsx scripts/original-product-map-expected-packages-backfill-dryrun.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const OUT_BASE = ".cursor/audit-reports/original-product-map-expected-packages-backfill-dryrun";
const APPROVAL_OUT = ".cursor/operator-approvals/original-product-map-ep-backfill-approval.md";
const PARITY_MANIFEST_GLOB = ".cursor/audit-reports/db-parity-view-linkage-slip-columns-original-execute";
const BOUND_LIMIT = 5000;

type Row = Record<string, string | number | null>;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, headers: string[], rows: Row[]): void {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

async function tableHasColumn(client: pg.Client, table: string, column: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

async function buildAsinExpr(client: pg.Client): Promise<string> {
  const hasCol = await tableHasColumn(client, "amazon_removals", "asin");
  return hasCol
    ? `COALESCE(NULLIF(TRIM(ar.asin), ''), NULLIF(TRIM(COALESCE(ar.raw_data->>'asin', ar.raw_data->>'ASIN')), ''))`
    : `NULLIF(TRIM(COALESCE(ar.raw_data->>'asin', ar.raw_data->>'ASIN')), '')`;
}

function mapDeletedFilter(hasDeleted: boolean): string {
  return hasDeleted ? "AND (m.deleted_at IS NULL)" : "";
}

function productsDeletedFilter(hasDeleted: boolean): string {
  return hasDeleted ? "AND (p.deleted_at IS NULL)" : "";
}

function parityPreconditionPass(): { pass: boolean; evidence: string } {
  const base = path.join(process.cwd(), PARITY_MANIFEST_GLOB);
  if (!fs.existsSync(base)) return { pass: false, evidence: "no original parity execute folder" };
  const runs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const run of runs) {
    const mf = path.join(base, run, "manifest.json");
    if (!fs.existsSync(mf)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(mf, "utf8")) as { status?: string };
      if (j.status === "PASS") return { pass: true, evidence: `${PARITY_MANIFEST_GLOB}/${run}/manifest.json` };
    } catch {
      /* skip */
    }
  }
  return { pass: false, evidence: `latest runs under ${PARITY_MANIFEST_GLOB} not PASS` };
}

async function countMetrics(client: pg.Client): Promise<Record<string, number>> {
  const ep = await client.query(`
    SELECT
      count(*)::int AS ep_total,
      count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS ep_resolved,
      count(*) FILTER (WHERE resolved_product_id IS NULL AND store_id IS NOT NULL)::int AS ep_unresolved_scoped,
      count(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND resolved_product_id IS NULL
      )::int AS ep_derived_unresolved,
      count(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND identifier_resolution_status = 'unresolved'
      )::int AS ep_status_unresolved_derived
    FROM public.expected_packages
  `);
  const mapHasDel = await tableHasColumn(client, "product_identifier_map", "deleted_at");
  const map = await client.query(`
    SELECT count(*)::int AS map_rows
    FROM public.product_identifier_map m
    WHERE m.product_id IS NOT NULL ${mapHasDel ? "AND m.deleted_at IS NULL" : ""}
  `);
  return {
    ...((ep.rows[0] ?? {}) as Record<string, number>),
    map_rows: (map.rows[0] as { map_rows: number }).map_rows,
  };
}

async function classificationQuery(client: pg.Client): Promise<Row[]> {
  const asinExpr = await buildAsinExpr(client);
  const mapDel = await tableHasColumn(client, "product_identifier_map", "deleted_at");
  const prodDel = await tableHasColumn(client, "products", "deleted_at");
  const hasEpUpc = await tableHasColumn(client, "expected_packages", "upc_code");
  const hasEpUpcAlt = await tableHasColumn(client, "expected_packages", "upc");
  const hasMapUpc = await tableHasColumn(client, "product_identifier_map", "upc_code");
  const upcExpr =
    hasEpUpc && hasEpUpcAlt
      ? `COALESCE(NULLIF(TRIM(t.upc_code), ''), NULLIF(TRIM(t.upc), ''))`
      : hasEpUpc
        ? `NULLIF(TRIM(t.upc_code), '')`
        : hasEpUpcAlt
          ? `NULLIF(TRIM(t.upc), '')`
          : `NULL::text`;

  const mDel = mapDeletedFilter(mapDel);
  const pDel = productsDeletedFilter(prodDel);

  const q = `
WITH base AS (
  SELECT
    t.id::text AS expected_package_id,
    t.organization_id::text,
    t.store_id::text,
    NULLIF(TRIM(t.fnsku), '') AS fnsku,
    NULLIF(TRIM(t.sku), '') AS sku,
    ${asinExpr} AS asin,
    ${upcExpr} AS upc,
    t.build_source,
    NULLIF(TRIM(t.tracking_number), '') AS tracking_number,
    NULLIF(TRIM(t.order_id), '') AS order_id
  FROM public.expected_packages t
  LEFT JOIN public.amazon_removals ar
    ON ar.id = t.source_detail_row_id AND ar.organization_id = t.organization_id
  WHERE t.resolved_product_id IS NULL
    AND t.store_id IS NOT NULL
    AND t.organization_id IS NOT NULL
    AND t.build_source IN ('detail_shipment', 'detail_remainder')
  LIMIT ${BOUND_LIMIT}
),
map_fnsku AS (
  SELECT b.expected_package_id,
    count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS n,
    (array_agg(DISTINCT m.product_id::text ORDER BY m.product_id::text))[1] AS single_pid,
    (array_agg(DISTINCT m.catalog_product_id::text ORDER BY m.catalog_product_id::text))[1] AS single_cpid
  FROM base b
  JOIN public.product_identifier_map m
    ON m.organization_id = b.organization_id::uuid AND m.store_id = b.store_id::uuid
   AND b.fnsku IS NOT NULL AND UPPER(TRIM(m.fnsku)) = UPPER(b.fnsku)
   ${mDel}
  GROUP BY b.expected_package_id
),
map_sku_asin AS (
  SELECT b.expected_package_id,
    count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS n,
    (array_agg(DISTINCT m.product_id::text ORDER BY m.product_id::text))[1] AS single_pid,
    (array_agg(DISTINCT m.catalog_product_id::text ORDER BY m.catalog_product_id::text))[1] AS single_cpid
  FROM base b
  JOIN public.product_identifier_map m
    ON m.organization_id = b.organization_id::uuid AND m.store_id = b.store_id::uuid
   AND b.sku IS NOT NULL AND b.asin IS NOT NULL
   AND UPPER(TRIM(COALESCE(m.seller_sku, m.msku))) = UPPER(b.sku)
   AND UPPER(TRIM(m.asin)) = UPPER(b.asin)
   ${mDel}
  GROUP BY b.expected_package_id
),
map_sku AS (
  SELECT b.expected_package_id,
    count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS n,
    (array_agg(DISTINCT m.product_id::text ORDER BY m.product_id::text))[1] AS single_pid,
    (array_agg(DISTINCT m.catalog_product_id::text ORDER BY m.catalog_product_id::text))[1] AS single_cpid
  FROM base b
  JOIN public.product_identifier_map m
    ON m.organization_id = b.organization_id::uuid AND m.store_id = b.store_id::uuid
   AND b.sku IS NOT NULL
   AND (UPPER(TRIM(COALESCE(m.seller_sku, m.msku))) = UPPER(b.sku))
   ${mDel}
  GROUP BY b.expected_package_id
),
map_asin AS (
  SELECT b.expected_package_id,
    count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS n,
    (array_agg(DISTINCT m.product_id::text ORDER BY m.product_id::text))[1] AS single_pid,
    (array_agg(DISTINCT m.catalog_product_id::text ORDER BY m.catalog_product_id::text))[1] AS single_cpid
  FROM base b
  JOIN public.product_identifier_map m
    ON m.organization_id = b.organization_id::uuid AND m.store_id = b.store_id::uuid
   AND b.asin IS NOT NULL AND UPPER(TRIM(m.asin)) = UPPER(b.asin)
   ${mDel}
  GROUP BY b.expected_package_id
),
${
  hasMapUpc
    ? `
map_upc AS (
  SELECT b.expected_package_id,
    count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS n,
    (array_agg(DISTINCT m.product_id::text ORDER BY m.product_id::text))[1] AS single_pid,
    (array_agg(DISTINCT m.catalog_product_id::text ORDER BY m.catalog_product_id::text))[1] AS single_cpid
  FROM base b
  JOIN public.product_identifier_map m
    ON m.organization_id = b.organization_id::uuid AND m.store_id = b.store_id::uuid
   AND b.upc IS NOT NULL AND NULLIF(TRIM(m.upc_code), '') = b.upc
   ${mDel}
  GROUP BY b.expected_package_id
),`
    : ""
}
prod_fnsku AS (
  SELECT b.expected_package_id,
    count(DISTINCT p.id)::int AS n,
    (array_agg(DISTINCT p.id::text ORDER BY p.id::text))[1] AS single_pid
  FROM base b
  JOIN public.products p
    ON p.organization_id = b.organization_id::uuid AND p.store_id = b.store_id::uuid
   AND b.fnsku IS NOT NULL AND UPPER(TRIM(p.fnsku)) = UPPER(b.fnsku)
   ${pDel}
  GROUP BY b.expected_package_id
),
prod_sku AS (
  SELECT b.expected_package_id,
    count(DISTINCT p.id)::int AS n,
    (array_agg(DISTINCT p.id::text ORDER BY p.id::text))[1] AS single_pid
  FROM base b
  JOIN public.products p
    ON p.organization_id = b.organization_id::uuid AND p.store_id = b.store_id::uuid
   AND b.sku IS NOT NULL AND UPPER(TRIM(p.sku)) = UPPER(b.sku)
   ${pDel}
  GROUP BY b.expected_package_id
),
prod_asin AS (
  SELECT b.expected_package_id,
    count(DISTINCT p.id)::int AS n,
    (array_agg(DISTINCT p.id::text ORDER BY p.id::text))[1] AS single_pid
  FROM base b
  JOIN public.products p
    ON p.organization_id = b.organization_id::uuid AND p.store_id = b.store_id::uuid
   AND b.asin IS NOT NULL AND UPPER(TRIM(p.asin)) = UPPER(b.asin)
   ${pDel}
  GROUP BY b.expected_package_id
),
${
  hasMapUpc
    ? `
prod_upc AS (
  SELECT b.expected_package_id,
    count(DISTINCT p.id)::int AS n,
    (array_agg(DISTINCT p.id::text ORDER BY p.id::text))[1] AS single_pid
  FROM base b
  JOIN public.products p
    ON p.organization_id = b.organization_id::uuid AND p.store_id = b.store_id::uuid
   AND b.upc IS NOT NULL
   AND (NULLIF(TRIM(p.upc_code), '') = b.upc OR NULLIF(TRIM(p.barcode), '') = b.upc)
   ${pDel}
  GROUP BY b.expected_package_id
),`
    : ""
}
scored AS (
  SELECT
    b.*,
    COALESCE(mf.n, 0) AS map_fnsku_n,
    COALESCE(msa.n, 0) AS map_sku_asin_n,
    COALESCE(ms.n, 0) AS map_sku_n,
    COALESCE(ma.n, 0) AS map_asin_n,
    ${hasMapUpc ? "COALESCE(mu.n, 0)" : "0"} AS map_upc_n,
    COALESCE(pf.n, 0) AS prod_fnsku_n,
    COALESCE(ps.n, 0) AS prod_sku_n,
    COALESCE(pa.n, 0) AS prod_asin_n,
    ${hasMapUpc ? "COALESCE(pu.n, 0)" : "0"} AS prod_upc_n,
    mf.single_pid AS map_fnsku_pid,
    msa.single_pid AS map_sku_asin_pid,
    ms.single_pid AS map_sku_pid,
    ma.single_pid AS map_asin_pid,
    ${hasMapUpc ? "mu.single_pid" : "NULL::text"} AS map_upc_pid,
    mf.single_cpid AS map_fnsku_cpid,
    msa.single_cpid AS map_sku_asin_cpid,
    ms.single_cpid AS map_sku_cpid,
    ma.single_cpid AS map_asin_cpid,
    ${hasMapUpc ? "mu.single_cpid" : "NULL::text"} AS map_upc_cpid,
    pf.single_pid AS prod_fnsku_pid,
    ps.single_pid AS prod_sku_pid,
    pa.single_pid AS prod_asin_pid,
    ${hasMapUpc ? "pu.single_pid" : "NULL::text"} AS prod_upc_pid
  FROM base b
  LEFT JOIN map_fnsku mf ON mf.expected_package_id = b.expected_package_id
  LEFT JOIN map_sku_asin msa ON msa.expected_package_id = b.expected_package_id
  LEFT JOIN map_sku ms ON ms.expected_package_id = b.expected_package_id
  LEFT JOIN map_asin ma ON ma.expected_package_id = b.expected_package_id
  ${hasMapUpc ? "LEFT JOIN map_upc mu ON mu.expected_package_id = b.expected_package_id" : ""}
  LEFT JOIN prod_fnsku pf ON pf.expected_package_id = b.expected_package_id
  LEFT JOIN prod_sku ps ON ps.expected_package_id = b.expected_package_id
  LEFT JOIN prod_asin pa ON pa.expected_package_id = b.expected_package_id
  ${hasMapUpc ? "LEFT JOIN prod_upc pu ON pu.expected_package_id = b.expected_package_id" : ""}
),
classified AS (
  SELECT s.*,
    CASE
      WHEN s.fnsku IS NULL AND s.sku IS NULL AND s.asin IS NULL AND s.upc IS NULL THEN 'E'
      WHEN GREATEST(s.map_fnsku_n, s.map_sku_asin_n, s.map_sku_n, s.map_asin_n, s.map_upc_n,
                    s.prod_fnsku_n, s.prod_sku_n, s.prod_asin_n, s.prod_upc_n) > 1 THEN 'D'
      WHEN s.map_fnsku_n = 1 THEN 'A'
      WHEN s.map_sku_asin_n = 1 THEN 'A'
      WHEN s.map_sku_n = 1 THEN 'A'
      WHEN s.map_asin_n = 1 THEN 'A'
      WHEN s.map_upc_n = 1 THEN 'A'
      WHEN s.prod_fnsku_n = 1 AND s.map_fnsku_n = 0 THEN 'B'
      WHEN s.prod_sku_asin_n = 1 AND s.map_sku_asin_n = 0 THEN 'B'
      WHEN s.prod_sku_n = 1 AND s.map_sku_n = 0 THEN 'B'
      WHEN s.prod_asin_n = 1 AND s.map_asin_n = 0 THEN 'B'
      WHEN s.prod_upc_n = 1 AND s.map_upc_n = 0 THEN 'B'
      ELSE 'C'
    END AS class_code,
    CASE
      WHEN s.map_fnsku_n = 1 THEN 'map_fnsku_tier1'
      WHEN s.map_sku_asin_n = 1 THEN 'map_sku_asin_tier2'
      WHEN s.map_sku_n = 1 THEN 'map_sku_tier3'
      WHEN s.map_asin_n = 1 THEN 'map_asin_tier4'
      WHEN s.map_upc_n = 1 THEN 'map_upc_tier5'
      WHEN s.prod_fnsku_n = 1 AND s.map_fnsku_n = 0 THEN 'propose_map_fnsku'
      WHEN s.prod_sku_n = 1 AND s.map_sku_n = 0 THEN 'propose_map_sku'
      WHEN s.prod_asin_n = 1 AND s.map_asin_n = 0 THEN 'propose_map_asin'
      WHEN s.prod_upc_n = 1 AND s.map_upc_n = 0 THEN 'propose_map_upc'
      WHEN s.fnsku IS NULL AND s.sku IS NULL AND s.asin IS NULL AND s.upc IS NULL THEN 'missing_identifiers'
      WHEN GREATEST(s.map_fnsku_n, s.map_sku_asin_n, s.map_sku_n, s.map_asin_n, s.map_upc_n,
                    s.prod_fnsku_n, s.prod_sku_n, s.prod_asin_n, s.prod_upc_n) > 1 THEN 'ambiguous_multi_product'
      ELSE 'needs_product_seed'
    END AS match_tier,
    CASE
      WHEN s.map_fnsku_n = 1 THEN s.map_fnsku_pid
      WHEN s.map_sku_asin_n = 1 THEN s.map_sku_asin_pid
      WHEN s.map_sku_n = 1 THEN s.map_sku_pid
      WHEN s.map_asin_n = 1 THEN s.map_asin_pid
      WHEN s.map_upc_n = 1 THEN s.map_upc_pid
      WHEN s.prod_fnsku_n = 1 AND s.map_fnsku_n = 0 THEN s.prod_fnsku_pid
      WHEN s.prod_sku_n = 1 AND s.map_sku_n = 0 THEN s.prod_sku_pid
      WHEN s.prod_asin_n = 1 AND s.map_asin_n = 0 THEN s.prod_asin_pid
      WHEN s.prod_upc_n = 1 AND s.map_upc_n = 0 THEN s.prod_upc_pid
      ELSE NULL
    END AS proposed_product_id,
    CASE
      WHEN s.map_fnsku_n = 1 THEN s.map_fnsku_cpid
      WHEN s.map_sku_asin_n = 1 THEN s.map_sku_asin_cpid
      WHEN s.map_sku_n = 1 THEN s.map_sku_cpid
      WHEN s.map_asin_n = 1 THEN s.map_asin_cpid
      WHEN s.map_upc_n = 1 THEN s.map_upc_cpid
      ELSE NULL
    END AS proposed_catalog_product_id
  FROM scored s
)
SELECT * FROM classified ORDER BY class_code, expected_package_id
`;

  // Fix typo prod_sku_asin_n - doesn't exist, remove that branch from CASE
  const fixedQ = q.replace(
    /WHEN s\.prod_sku_asin_n = 1 AND s\.map_sku_asin_n = 0 THEN 'B'\n/g,
    "",
  );

  const res = await client.query(fixedQ);
  return res.rows as Row[];
}

function buildProposedSql(rows: Row[]): string {
  const lines: string[] = [
    "-- DRY-RUN ONLY — do not execute without operator approval",
    "-- Target: original kxsvedvpjldygtdbylsy",
    "-- Class A: UPDATE expected_packages only (existing product_identifier_map)",
    "-- Class B: INSERT product_identifier_map + UPDATE expected_packages",
    "",
  ];

  const classA = rows.filter((r) => r.class_code === "A");
  const classB = rows.filter((r) => r.class_code === "B");

  lines.push(`-- Class A count: ${classA.length}`);
  for (const r of classA.slice(0, 50)) {
    lines.push(
      `-- UPDATE public.expected_packages SET resolved_product_id = '${r.proposed_product_id}', identifier_resolution_status = 'matched', identifier_resolution_confidence = CASE '${r.match_tier}' WHEN 'map_fnsku_tier1' THEN 1.0 WHEN 'map_sku_tier3' THEN 0.85 WHEN 'map_asin_tier4' THEN 0.7 ELSE 0.9 END, updated_at = now() WHERE id = '${r.expected_package_id}'::uuid;`,
    );
  }
  if (classA.length > 50) lines.push(`-- ... ${classA.length - 50} more Class A updates`);

  lines.push("", `-- Class B count: ${classB.length}`);
  for (const r of classB.slice(0, 50)) {
    const sku = r.sku ? `'${String(r.sku).replace(/'/g, "''")}'` : "NULL";
    const fnsku = r.fnsku ? `'${String(r.fnsku).replace(/'/g, "''")}'` : "NULL";
    const asin = r.asin ? `'${String(r.asin).replace(/'/g, "''")}'` : "NULL";
    const upc = r.upc ? `'${String(r.upc).replace(/'/g, "''")}'` : "NULL";
    lines.push(
      `-- INSERT INTO public.product_identifier_map (organization_id, store_id, product_id, fnsku, seller_sku, asin, upc_code, match_source) VALUES ('${r.organization_id}'::uuid, '${r.store_id}'::uuid, '${r.proposed_product_id}'::uuid, ${fnsku}, ${sku}, ${asin}, ${upc}, 'original_ep_backfill_dryrun');`,
    );
    lines.push(
      `-- UPDATE public.expected_packages SET resolved_product_id = '${r.proposed_product_id}'::uuid, identifier_resolution_status = 'matched', updated_at = now() WHERE id = '${r.expected_package_id}'::uuid;`,
    );
  }
  if (classB.length > 50) lines.push(`-- ... ${classB.length - 50} more Class B map inserts + updates`);

  lines.push("", "-- Class C/D/E: no auto SQL in this dry-run");
  return lines.join("\n") + "\n";
}

const APPROVAL_TEMPLATE = `# Original — product_identifier_map + expected_packages backfill

**Default:** not approved.

| Field | Value |
|-------|--------|
| Target ref | \`kxsvedvpjldygtdbylsy\` |
| Branch | \`feature/product-canonicalization-v3\` |
| Dry-run evidence | \`.cursor/audit-reports/original-product-map-expected-packages-backfill-dryrun/<run_id>/\` |

## Preconditions

- [ ] \`DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE\` **PASS**
- [ ] Dry-run CSVs reviewed (Class A/B only for execute)
- [ ] Class C (product seed) explicitly excluded
- [ ] No product_name/title/OCR identity
- [ ] No staging row copy

## Allowed (execute prompt only)

- \`UPDATE public.expected_packages\` for Class **A** rows (existing map hit)
- \`INSERT public.product_identifier_map\` + \`UPDATE expected_packages\` for Class **B** rows (unique products.id, scoped org+store)
- Audit table per run

## Forbidden

- Product auto-create from title/OCR
- Blind staging→original copy
- Class C/D/E mutations in wave 1
- Claims / package_items schema changes

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PRODUCT_MAP_EP_BACKFILL=false
APPROVED_CLASS_A_EP_UPDATES=false
APPROVED_CLASS_B_MAP_INSERTS=false
TARGET_SUPABASE_REF=kxsvedvpjldygtdbylsy
\`\`\`

## Sign-off

\`\`\`
Approved by:
UTC date:
Notes:
\`\`\`
`;

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    /* */
  }

  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const connRef = refFromConnectionUrl(originalUrl);
  const parity = parityPreconditionPass();

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch ${branch} !== ${REQUIRED_BRANCH}`);
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (connRef !== ORIGINAL_REF && !originalUrl.includes(ORIGINAL_REF)) {
    blockers.push(`Connection ref ${connRef ?? "null"} !== ${ORIGINAL_REF}`);
  }
  if (originalUrl === stagingUrl) blockers.push("ORIGINAL URL must not equal staging URL");
  if (!parity.pass) blockers.push(`Precondition FAIL: original view/slip parity execute — ${parity.evidence}`);

  let originalMetrics: Record<string, number> = {};
  let stagingMetrics: Record<string, number> = {};
  let rows: Row[] = [];

  const client = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    originalMetrics = await countMetrics(client);
    rows = await classificationQuery(client);
  } finally {
    await client.end();
  }

  if (stagingUrl && refFromConnectionUrl(stagingUrl) === STAGING_REF) {
    const sc = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    await sc.connect();
    try {
      stagingMetrics = await countMetrics(sc);
    } finally {
      await sc.end();
    }
  }

  const byClass = (code: string) => rows.filter((r) => r.class_code === code);
  const counts = {
    A: byClass("A").length,
    B: byClass("B").length,
    C: byClass("C").length,
    D: byClass("D").length,
    E: byClass("E").length,
    total: rows.length,
  };

  const csvHeaders = [
    "expected_package_id",
    "organization_id",
    "store_id",
    "fnsku",
    "sku",
    "asin",
    "upc",
    "build_source",
    "tracking_number",
    "order_id",
    "class_code",
    "match_tier",
    "proposed_product_id",
    "proposed_catalog_product_id",
  ];

  writeCsv(path.join(outDir, "unresolved-ep-input.csv"), csvHeaders, rows);
  writeCsv(path.join(outDir, "class-a-existing-map-updates.csv"), csvHeaders, byClass("A"));
  writeCsv(path.join(outDir, "class-b-proposed-map-inserts.csv"), csvHeaders, byClass("B"));
  writeCsv(path.join(outDir, "class-c-product-seed-needed.csv"), csvHeaders, byClass("C"));
  writeCsv(path.join(outDir, "class-d-conflicts.csv"), csvHeaders, byClass("D"));
  writeCsv(path.join(outDir, "class-e-missing-identifiers.csv"), csvHeaders, byClass("E"));

  fs.writeFileSync(path.join(outDir, "proposed-sql-dryrun.sql"), buildProposedSql(rows));
  fs.writeFileSync(path.join(outDir, "approval-template.md"), APPROVAL_TEMPLATE);
  if (!fs.existsSync(path.join(process.cwd(), APPROVAL_OUT))) {
    fs.writeFileSync(path.join(process.cwd(), APPROVAL_OUT), APPROVAL_TEMPLATE);
  }

  fs.writeFileSync(
    path.join(outDir, "rollback-plan.md"),
    [
      "# Rollback plan",
      "",
      "1. Capture audit table `original_ep_map_backfill_audit_<run_id>` before execute (created at execute time).",
      "2. Revert `expected_packages` updates: `UPDATE ... SET resolved_product_id = NULL` from audit old values.",
      "3. Class B map inserts: delete rows where `match_source = 'original_ep_backfill_<run_id>'` (execute must tag source).",
      "4. No product rows were created in this wave.",
    ].join("\n") + "\n",
  );

  const executeReady = parity.pass && counts.A + counts.B > 0;

  fs.writeFileSync(
    path.join(outDir, "dryrun-summary.md"),
    [
      "# Dry-run summary",
      "",
      `| Field | Value |`,
      `|-------|--------|`,
      `| Run ID | \`${runId}\` |`,
      `| Target | original \`${ORIGINAL_REF}\` |`,
      `| Branch | \`${branch}\` |`,
      `| Mode | READ-ONLY |`,
      `| Parity precondition | ${parity.pass ? "PASS" : "**FAIL**"} (${parity.evidence}) |`,
      `| Bounded unresolved EP rows | ${counts.total} (limit ${BOUND_LIMIT}) |`,
      "",
      "## Classification counts",
      "",
      "| Class | Meaning | Count |",
      "|-------|---------|------:|",
      "| A | Safe EP update via existing map | " + counts.A + " |",
      "| B | Proposed map insert + EP update | " + counts.B + " |",
      "| C | Needs product seed (excluded) | " + counts.C + " |",
      "| D | Conflict / ambiguous | " + counts.D + " |",
      "| E | Missing identifiers | " + counts.E + " |",
      "",
      "## Staging vs original (read-only census)",
      "",
      "| Metric | Staging | Original |",
      "|--------|--------:|---------:|",
      `| product_identifier_map rows | ${stagingMetrics.map_rows ?? "n/a"} | ${originalMetrics.map_rows ?? "n/a"} |`,
      `| expected_packages total | ${stagingMetrics.ep_total ?? "n/a"} | ${originalMetrics.ep_total ?? "n/a"} |`,
      `| EP resolved | ${stagingMetrics.ep_resolved ?? "n/a"} | ${originalMetrics.ep_resolved ?? "n/a"} |`,
      `| EP unresolved (scoped, rpid null) | ${stagingMetrics.ep_unresolved_scoped ?? "n/a"} | ${originalMetrics.ep_unresolved_scoped ?? "n/a"} |`,
      `| EP derived unresolved (rpid null) | ${stagingMetrics.ep_derived_unresolved ?? "n/a"} | ${originalMetrics.ep_derived_unresolved ?? "n/a"} |`,
      `| EP derived status=unresolved | ${stagingMetrics.ep_status_unresolved_derived ?? "n/a"} | ${originalMetrics.ep_status_unresolved_derived ?? "n/a"} |`,
      "",
      "_Memory note (20260528): historical **2,413** derived-unresolved referred to post–data-wave census; live original now shows lower `resolved_product_id` null counts after subsequent resolver passes._",
      "",
      "## Policy",
      "",
      "- product_identifier_map is canonical resolver; seller_sku scoped by organization_id + store_id.",
      "- UPC tier only when unique single map/products match.",
      "- product_name/title/OCR never used for identity.",
      "",
      "## Blockers",
      "",
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["- None for dry-run read"]),
      "",
      `**Execute-ready after parity PASS:** ${executeReady ? "YES (Class A/B review)" : "NO"}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "exact-next-prompt.md"),
    parity.pass
      ? "# Next\n\n```text\nORIGINAL-PRODUCT-MAP-EP-BACKFILL-EXECUTE — operator signs .cursor/operator-approvals/original-product-map-ep-backfill-approval.md; apply Class A EP updates then Class B governed map inserts only\n```\n"
      : "# Next\n\n```text\nDB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE — must PASS before ORIGINAL-PRODUCT-MAP-EP-BACKFILL-EXECUTE\n```\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        status: "DRYRUN_COMPLETE",
        target_ref: ORIGINAL_REF,
        parity_precondition_pass: parity.pass,
        classification_counts: counts,
        original_metrics: originalMetrics,
        staging_metrics: stagingMetrics,
        blockers,
        data_backfill_execute_ready: executeReady,
        exact_next_prompt: parity.pass
          ? "ORIGINAL-PRODUCT-MAP-EP-BACKFILL-EXECUTE"
          : "DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE",
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify({ runId, outDir, counts, parity, blockers, executeReady }, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
