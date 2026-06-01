/**
 * PRODUCT-LINKAGE-PHASE1-UNRESOLVED-EXPECTED-PACKAGES-PLAN (read-only)
 *   npx tsx scripts/product-linkage-phase1-unresolved-expected-packages-plan.ts --run-id=<UTC>
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
const OUT_BASE = ".cursor/audit-reports/product-linkage-phase1-unresolved-expected-packages-plan";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type ClassKey = "A" | "B" | "C" | "D" | "E";

const CLASS_LABELS: Record<ClassKey, string> = {
  A: "map exists — safe EP resolved_product_id backfill",
  B: "product exists, map missing — safe map bridge insert",
  C: "no product spine match — blocked until governed product seed",
  D: "ambiguous / identifier conflict — manual review",
  E: "missing identifiers — enrichment only, no product inference",
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

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(
    filePath,
    [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") + "\n",
  );
}

async function columns(client: pg.Client, name: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function buildClassifySql(epCols: Set<string>, mapCols: Set<string>, prodCols: Set<string>): string {
  const hasFnsku = epCols.has("fnsku");
  const hasSku = epCols.has("sku");
  const hasAsin = epCols.has("asin");
  const hasUpc = epCols.has("upc");
  const hasMapMsku = mapCols.has("msku");
  const hasMapAsin = mapCols.has("asin");
  const hasMapUpc = mapCols.has("upc_code");
  const hasProdAsin = prodCols.has("asin");
  const hasProdFnsku = prodCols.has("fnsku");
  const hasProdSku = prodCols.has("sku");
  const hasProdUpc = prodCols.has("upc_code") || prodCols.has("barcode");

  const baseSelect = [
    "ep.id",
    "ep.organization_id",
    "ep.store_id",
    "ep.tracking_number",
    hasSku ? "ep.sku" : "NULL::text AS sku",
    hasFnsku ? "ep.fnsku" : "NULL::text AS fnsku",
    hasAsin ? "ep.asin" : "NULL::text AS asin",
    hasUpc ? "ep.upc" : "NULL::text AS upc",
    "ep.resolved_product_id",
    epCols.has("identifier_resolution_status")
      ? "ep.identifier_resolution_status"
      : "NULL::text AS identifier_resolution_status",
    epCols.has("build_source") ? "ep.build_source" : "NULL::text AS build_source",
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
  if (hasAsin && hasMapAsin) mapMatch.push("(b.has_asin AND upper(btrim(m.asin)) = upper(btrim(b.asin)))");
  if (hasUpc && hasMapUpc) mapMatch.push("(b.has_upc AND upper(btrim(m.upc_code)) = upper(btrim(b.upc)))");
  const mapOr = mapMatch.length ? mapMatch.join("\n     OR ") : "false";

  const prodMatch: string[] = [];
  if (hasFnsku && hasProdFnsku) prodMatch.push("(b.has_fnsku AND upper(btrim(p.fnsku)) = upper(btrim(b.fnsku)))");
  if (hasSku && hasProdSku) prodMatch.push("(b.has_sku AND upper(btrim(p.sku)) = upper(btrim(b.sku)))");
  if (hasAsin && hasProdAsin) prodMatch.push("(b.has_asin AND upper(btrim(p.asin)) = upper(btrim(b.asin)))");
  if (hasUpc && hasProdUpc) {
    prodMatch.push(
      prodCols.has("upc_code")
        ? "(b.has_upc AND upper(btrim(p.upc_code)) = upper(btrim(b.upc)))"
        : "(b.has_upc AND upper(btrim(p.barcode)) = upper(btrim(b.upc)))",
    );
  }
  const prodOr = prodMatch.length ? prodMatch.join("\n     OR ") : "false";

  const missingCheck = [hasFnsku && "b.has_fnsku", hasSku && "b.has_sku", hasAsin && "b.has_asin", hasUpc && "b.has_upc"]
    .filter(Boolean)
    .join(" OR ") || "false";

  const idBucketSql = `
    CASE
      WHEN NOT (${missingCheck}) THEN 'missing_all_identifiers'
      WHEN b.has_fnsku AND NOT b.has_sku AND NOT b.has_asin THEN 'fnsku_only'
      WHEN b.has_sku AND NOT b.has_fnsku AND NOT b.has_asin THEN 'sku_only'
      WHEN b.has_asin AND NOT b.has_fnsku AND NOT b.has_sku THEN 'asin_only'
      WHEN b.has_fnsku AND b.has_sku THEN 'fnsku_and_sku'
      WHEN b.has_fnsku AND b.has_asin THEN 'fnsku_and_asin'
      WHEN b.has_sku AND b.has_asin THEN 'sku_and_asin'
      ELSE 'mixed_identifiers'
    END AS identifier_bucket`;

  return `
WITH base AS (
  SELECT ${baseSelect}
  FROM public.expected_packages ep
  WHERE ep.resolved_product_id IS NULL
),
map_products AS (
  SELECT
    b.id,
    COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count,
    MAX(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS sample_map_product_id,
    MAX(m.id::text) FILTER (WHERE m.product_id IS NOT NULL) AS sample_map_id,
    MAX(m.seller_sku) FILTER (WHERE m.product_id IS NOT NULL) AS sample_map_seller_sku,
    MAX(m.fnsku) FILTER (WHERE m.product_id IS NOT NULL) AS sample_map_fnsku,
    MAX(m.match_source) FILTER (WHERE m.product_id IS NOT NULL) AS sample_map_match_source
  FROM base b
  LEFT JOIN public.product_identifier_map m
    ON m.deleted_at IS NULL
   AND m.organization_id = b.organization_id
   AND (m.store_id = b.store_id OR m.store_id IS NULL)
   AND (${mapOr})
  GROUP BY b.id
),
direct_products AS (
  SELECT
    b.id,
    COUNT(DISTINCT p.id)::int AS product_count,
    MAX(p.id::text) AS sample_product_id,
    MAX(p.product_name) AS sample_product_name,
    MAX(p.sku) AS sample_product_sku,
    ${hasProdAsin ? "MAX(p.asin)" : "NULL::text"} AS sample_product_asin,
    ${hasProdFnsku ? "MAX(p.fnsku)" : "NULL::text"} AS sample_product_fnsku
  FROM base b
  LEFT JOIN public.products p
    ON p.organization_id = b.organization_id
   AND p.store_id = b.store_id
   AND (${prodOr})
  GROUP BY b.id
),
classified AS (
  SELECT
    b.*,
    COALESCE(mp.map_product_count, 0) AS map_product_count,
    COALESCE(dp.product_count, 0) AS product_count,
    mp.sample_map_product_id,
    mp.sample_map_id,
    mp.sample_map_seller_sku,
    mp.sample_map_fnsku,
    mp.sample_map_match_source,
    dp.sample_product_id,
    dp.sample_product_name,
    dp.sample_product_sku,
    dp.sample_product_asin,
    dp.sample_product_fnsku,
    CASE
      WHEN NOT (${missingCheck}) THEN 'E'
      WHEN b.identifier_resolution_status = 'ambiguous' THEN 'D'
      WHEN COALESCE(mp.map_product_count, 0) > 1 OR COALESCE(dp.product_count, 0) > 1 THEN 'D'
      WHEN COALESCE(mp.map_product_count, 0) = 1 THEN 'A'
      WHEN COALESCE(dp.product_count, 0) = 1 AND COALESCE(mp.map_product_count, 0) = 0 THEN 'B'
      ELSE 'C'
    END AS linkage_class,
    ${idBucketSql}
  FROM base b
  LEFT JOIN map_products mp ON mp.id = b.id
  LEFT JOIN direct_products dp ON dp.id = b.id
)
SELECT * FROM classified
`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

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

  const summary = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL AND identifier_resolution_status = 'ambiguous')::int AS ambiguous_status,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL AND identifier_resolution_status = 'unresolved')::int AS unresolved_status
    FROM public.expected_packages
  `);

  const epCols = await columns(client, "expected_packages");
  const mapCols = await columns(client, "product_identifier_map");
  const prodCols = await columns(client, "products");
  const classifySql = buildClassifySql(epCols, mapCols, prodCols);

  const classified = await client.query(classifySql);
  const rows = classified.rows as Record<string, unknown>[];

  const classCounts: Record<ClassKey, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const idBuckets: Record<string, number> = {};
  for (const r of rows) {
    const c = r.linkage_class as ClassKey;
    classCounts[c] = (classCounts[c] ?? 0) + 1;
    const b = String(r.identifier_bucket);
    idBuckets[b] = (idBuckets[b] ?? 0) + 1;
  }

  const classA = rows.filter((r) => r.linkage_class === "A");
  const classB = rows.filter((r) => r.linkage_class === "B");
  const classC = rows.filter((r) => r.linkage_class === "C");
  const classD = rows.filter((r) => r.linkage_class === "D");
  const classE = rows.filter((r) => r.linkage_class === "E");

  const mapBridgeCandidates = classB.map((r) => ({
    expected_package_id: r.id,
    tracking_number: r.tracking_number,
    ep_sku: r.sku,
    ep_fnsku: r.fnsku,
    ep_asin: r.asin,
    proposed_product_id: r.sample_product_id,
    proposed_seller_sku: r.sku ?? r.sample_product_sku,
    proposed_fnsku: r.fnsku ?? r.sample_product_fnsku,
    proposed_asin: r.asin ?? r.sample_product_asin,
    product_name: r.sample_product_name,
    apply_action: "INSERT product_identifier_map bridge only (no product create)",
  }));

  const epBackfillCandidates = classA.map((r) => ({
    expected_package_id: r.id,
    tracking_number: r.tracking_number,
    ep_sku: r.sku,
    ep_fnsku: r.fnsku,
    proposed_resolved_product_id: r.sample_map_product_id,
    sample_map_id: r.sample_map_id,
    sample_map_match_source: r.sample_map_match_source,
    product_name: r.sample_product_name,
    apply_action: "UPDATE expected_packages.resolved_product_id from existing map",
  }));

  const sampleClassA = epBackfillCandidates.slice(0, 25);
  const sampleClassB = mapBridgeCandidates.slice(0, 25);

  const scannerImpact = await client.query(`
    WITH unresolved AS (
      SELECT id FROM public.expected_packages WHERE resolved_product_id IS NULL
    )
    SELECT
      COUNT(*)::int AS view_rows_for_unresolved_ep,
      COUNT(*) FILTER (WHERE v.product_name IS NOT NULL)::int AS with_product_name,
      COUNT(*) FILTER (WHERE v.product_name IS NULL)::int AS without_product_name,
      COUNT(*) FILTER (WHERE v.resolved_product_id IS NOT NULL)::int AS view_has_resolved_id,
      COUNT(*) FILTER (WHERE v.product_display_name IS NOT NULL)::int AS with_display_name
    FROM public.v_inventory_item_status v
    WHERE v.expected_package_id IN (SELECT id FROM unresolved)
  `);

  const claimsImpact = await client.query(`
    SELECT
      COUNT(*)::int AS active_return_items,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS ri_resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS ri_unresolved,
      COUNT(*) FILTER (WHERE expected_item_id IS NOT NULL)::int AS with_expected_item_id,
      COUNT(*) FILTER (
        WHERE expected_item_id IS NOT NULL
          AND resolved_product_id IS NULL
          AND EXISTS (
            SELECT 1 FROM public.expected_packages ep
            WHERE ep.id = return_items.expected_item_id
              AND ep.resolved_product_id IS NULL
          )
      )::int AS ri_linked_unresolved_ep,
      COUNT(*) FILTER (
        WHERE expected_item_id IS NOT NULL
          AND resolved_product_id IS NULL
          AND EXISTS (
            SELECT 1 FROM public.expected_packages ep
            WHERE ep.id = return_items.expected_item_id
              AND ep.resolved_product_id IS NOT NULL
          )
      )::int AS ri_unresolved_ep_resolved
    FROM public.return_items
    WHERE deleted_at IS NULL
  `);

  const buildSourceBreakdown = await client.query(`
    SELECT
      COALESCE(build_source, '(null)') AS build_source,
      COUNT(*)::int AS unresolved_count
    FROM public.expected_packages
    WHERE resolved_product_id IS NULL
    GROUP BY 1
    ORDER BY unresolved_count DESC
  `);

  const classCSub = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE upper(btrim(sku)) = 'UNKNOW')::int AS sku_unknown,
      COUNT(*) FILTER (WHERE sku ILIKE '%return%')::int AS sku_return_pattern,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.product_identifier_map m
        WHERE m.deleted_at IS NULL
          AND upper(btrim(m.fnsku)) = upper(btrim(ep.fnsku))
      ))::int AS fnsku_in_map_any_store,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.products p
        WHERE upper(btrim(p.fnsku)) = upper(btrim(ep.fnsku))
      ))::int AS fnsku_in_products_any,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.catalog_products cp
        WHERE upper(btrim(cp.fnsku)) = upper(btrim(ep.fnsku))
           OR upper(btrim(cp.seller_sku)) = upper(btrim(ep.sku))
      ))::int AS in_catalog_products
    FROM public.expected_packages ep
    WHERE ep.resolved_product_id IS NULL
  `);

  await client.end();

  const csvHeaders = [
    "expected_package_id",
    "tracking_number",
    "linkage_class",
    "identifier_bucket",
    "sku",
    "fnsku",
    "asin",
    "map_product_count",
    "product_count",
    "identifier_resolution_status",
    "sample_map_product_id",
    "sample_product_id",
    "sample_product_name",
    "build_source",
  ];
  const toCsv = (list: Record<string, unknown>[]) =>
    list.map((r) => ({
      expected_package_id: r.id,
      tracking_number: r.tracking_number,
      linkage_class: r.linkage_class,
      identifier_bucket: r.identifier_bucket,
      sku: r.sku,
      fnsku: r.fnsku,
      asin: r.asin,
      map_product_count: r.map_product_count,
      product_count: r.product_count,
      identifier_resolution_status: r.identifier_resolution_status,
      sample_map_product_id: r.sample_map_product_id,
      sample_product_id: r.sample_product_id,
      sample_product_name: r.sample_product_name,
      build_source: r.build_source,
    }));

  writeCsv(path.join(outDir, "all-unresolved-classified.csv"), csvHeaders, toCsv(rows));
  writeCsv(path.join(outDir, "safe-map-bridge-class-b.csv"), Object.keys(mapBridgeCandidates[0] ?? {}), mapBridgeCandidates);
  writeCsv(path.join(outDir, "manual-review-class-d.csv"), csvHeaders, toCsv(classD));
  writeCsv(path.join(outDir, "blocked-product-create-class-c.csv"), csvHeaders, toCsv(classC));
  writeCsv(
    path.join(outDir, "sample-wave-class-a-ep-backfill.csv"),
    Object.keys(sampleClassA[0] ?? {}),
    sampleClassA,
  );
  writeCsv(
    path.join(outDir, "sample-wave-class-b-map-bridge.csv"),
    Object.keys(sampleClassB[0] ?? {}),
    sampleClassB,
  );

  const s = summary.rows[0] as Record<string, number>;
  const scan = scannerImpact.rows[0] as Record<string, number>;
  const claims = claimsImpact.rows[0] as Record<string, number>;
  const cSub = classCSub.rows[0] as Record<string, number>;

  const report = `# PRODUCT-LINKAGE-PHASE1-UNRESOLVED-EXPECTED-PACKAGES-PLAN

Run: \`${runId}\`  
Mode: **read-only** · staging \`${STAGING_REF}\` only  
Architecture: Product Core spine (\`products\` + \`product_identifier_map\` + \`catalog_products\`)

# UNRESOLVED_EP_BUCKETS

## Spine summary

| Metric | Count |
|--------|------:|
| Total \`expected_packages\` | ${s.total} |
| Resolved | ${s.resolved} |
| **Unresolved** | **${s.unresolved}** |
| \`identifier_resolution_status = ambiguous\` | ${s.ambiguous_status} |
| \`identifier_resolution_status = unresolved\` | ${s.unresolved_status} |

## Linkage classification (unresolved only)

| Class | Meaning | Count |
|-------|---------|------:|
${(Object.keys(CLASS_LABELS) as ClassKey[])
  .map((k) => `| **${k}** | ${CLASS_LABELS[k]} | **${classCounts[k]}** |`)
  .join("\n")}

## Identifier availability (unresolved EP rows)

| Bucket | Count |
|--------|------:|
${Object.entries(idBuckets)
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `| ${k} | ${n} |`)
  .join("\n")}

## Unresolved by \`build_source\`

| build_source | unresolved |
|--------------|----------:|
${buildSourceBreakdown.rows.map((r: { build_source: string; unresolved_count: number }) => `| ${r.build_source} | ${r.unresolved_count} |`).join("\n")}

# GAP_DIAGNOSIS

| Gap type | Class | Count | Safe auto-fix? |
|----------|-------|------:|:--------------:|
| Map exists, EP not persisted | **A** | ${classCounts.A} | Yes — EP \`resolved_product_id\` backfill |
| Product exists, map bridge missing | **B** | ${classCounts.B} | Yes — map insert only |
| No spine match | **C** | ${classCounts.C} | **No** — blocked until governed product seed |
| Multi-map / multi-product / ambiguous status | **D** | ${classCounts.D} | **No** — manual review |
| Missing ASIN/FNSKU/SKU/UPC on EP | **E** | ${classCounts.E} | Enrichment only — no title/OCR merge |

# SAFE_MAP_CANDIDATES

**Class B — ${classCounts.B} rows** where \`products\` matches org+store+identifier but \`product_identifier_map\` bridge is missing.

- File: \`safe-map-bridge-class-b.csv\`
- Rule: deterministic identifier match only; no product INSERT; no fuzzy name merge
- Sample wave (max 25): \`sample-wave-class-b-map-bridge.csv\`

# MANUAL_REVIEW_CANDIDATES

**Class D — ${classCounts.D} rows** — ambiguous multi-map, multi-product, or \`identifier_resolution_status = ambiguous\`.

- File: \`manual-review-class-d.csv\`
- Do not auto-link; operator must pick canonical product or quarantine

**Class E — ${classCounts.E} rows** — missing identifiers on EP; enrich from slip/import evidence only.

# BLOCKED_PRODUCT_CREATE_CANDIDATES

**Class C — ${classCounts.C} rows** — identifiers present but no unique \`products\` or \`product_identifier_map\` match.

- File: \`blocked-product-create-class-c.csv\`
- Blocked from auto-apply until governed PIM/sheet product seed (separate approval)
- Forbidden: title/OCR/name fuzzy merge; auto-create from scanner text

## Class C sub-buckets (staging live)

| Signal | Count |
|--------|------:|
| Total Class C | ${cSub.total ?? classCounts.C} |
| SKU = \`UNKNOW\` | ${cSub.sku_unknown ?? 0} |
| SKU contains \`return\` | ${cSub.sku_return_pattern ?? 0} |
| FNSKU exists in map (any store, org) | ${cSub.fnsku_in_map_any_store ?? 0} |
| FNSKU exists in \`products\` (any store) | ${cSub.fnsku_in_products_any ?? 0} |
| Row in \`catalog_products\` by FNSKU/SKU | ${cSub.in_catalog_products ?? 0} |

**Interpretation:** Unresolved removal/detail EP rows carry FNSKU+SKU but **none** resolve through org+store spine joins. Most are one-off return/removal MSKUs (\`UNKNOW\`, \`10012023-return-*\`, \`LIT-*\`) with no \`products\` / \`product_identifier_map\` bridge yet.

# CLASS_A_EP_BACKFILL

**${classCounts.A} rows** — map already resolves to exactly one \`product_id\`; EP \`resolved_product_id\` not persisted.

- Lowest risk lane
- Sample wave (max 25): \`sample-wave-class-a-ep-backfill.csv\`

# SCANNER_AND_CLAIMS_IMPACT

## Scanner (\`v_inventory_item_status\` rows tied to unresolved EP)

| Metric | Count |
|--------|------:|
| View rows for unresolved EP | ${scan.view_rows_for_unresolved_ep ?? 0} |
| With \`product_name\` (may be stale/slip-derived) | ${scan.with_product_name ?? 0} |
| Without \`product_name\` | ${scan.without_product_name ?? 0} |
| View has \`resolved_product_id\` while EP unresolved | ${scan.view_has_resolved_id ?? 0} |

**Effect of Class A backfill:** EP \`resolved_product_id\` → scanner read contract can show spine \`product_name\` via \`ProductLinkageDisplayContract\` without title merge.

**Effect of Class B map bridge:** Enables map-tier resolution for scanner/expected reads; still no product create.

## Claims (\`return_items\`)

| Metric | Count |
|--------|------:|
| Active return items | ${claims.active_return_items} |
| RI resolved | ${claims.ri_resolved} |
| RI unresolved | ${claims.ri_unresolved} |
| With \`expected_item_id\` | ${claims.with_expected_item_id} |
| RI linked to unresolved EP (both unresolved) | ${claims.ri_linked_unresolved_ep} |
| RI unresolved but EP resolved (copy candidate — **physical anchor gate required**) | ${claims.ri_unresolved_ep_resolved} |

**Do not bulk-copy EP → RI \`resolved_product_id\`** without proven physical scan linkage (architecture lock).

# MAX_25_SAFE_APPLY_PROMPT

**Current staging state:** **0 Class A** and **0 Class B** candidates — linkage sample wave is **blocked** until spine rows exist for these FNSKUs.

When Class A/B rows appear (after governed product seed or map bridge from sheet/API waves):

\`\`\`text
PRODUCT-LINKAGE-PHASE1-SAMPLE-WAVE-STAGING-EXECUTE

Target: staging eiqfaapyumhixxoeltgu only
Plan: .cursor/audit-reports/product-linkage-phase1-unresolved-expected-packages-plan/${runId}/

Wave 1 (lowest risk — Class A):
- Apply sample-wave-class-a-ep-backfill.csv (≤25)
- UPDATE expected_packages.resolved_product_id ONLY where map_product_count=1 and currently NULL
- Zero product INSERT; zero map INSERT; zero title/name overwrite

Wave 2 (after Wave 1 verify — Class B):
- Apply sample-wave-class-b-map-bridge.csv (≤25)
- INSERT product_identifier_map bridge rows only where products row exists and no active map conflict
- Then optional EP resolved_product_id backfill for those rows

Forbidden:
- Class C/D/E rows
- Product creation
- Fuzzy title/OCR/name merge
- EP→RI bulk resolved_product_id copy
- Original DB / merge / deploy

Required flags:
APPROVED_TO_RUN_STAGING=true
APPROVED_EP_LINKAGE_PHASE1_SAMPLE=true
APPROVED_EP_RESOLVED_BACKFILL_MAX_25=true
APPROVED_MAP_BRIDGE_MAX_25=false  # enable after Wave 1 verify
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
\`\`\`

**Interim prompt (Class C spine gap — before linkage apply):**

\`\`\`text
EXPECTED-PACKAGES-UNRESOLVED-FNSKU-ENRICHMENT-READONLY

Census 320 Class C EP rows by FNSKU; cross-check Amazon SP-API / sheet / catalog evidence;
export governed product-seed candidates — no auto-create.
\`\`\`

# WHAT_NOT_TO_TOUCH

| Area | Rule |
|------|------|
| **Original DB** (\`kxsvedvpjldygtdbylsy\`) | Read-only census only; no writes without explicit approval |
| **Class C** (${classCounts.C} EP rows) | No auto product seed from title/OCR/scanner |
| **Class D** (${classCounts.D} EP rows) | No auto-link on ambiguous multi-map/product |
| **Class E** (${classCounts.E} EP rows) | Enrichment evidence only; no product inference |
| **return_items bulk backfill** | No EP→RI \`resolved_product_id\` copy without physical-anchor gate |
| **Product sheet class-A mismatches** | 21 identifier conflicts — separate queue |
| **Product Core resolver tiers** | Do not rewrite matching/merge logic |
| **Merge / deploy / cron** | Off |
| **package_items / auto-promote** | Forbidden |

# ARTIFACTS

| File | Purpose |
|------|---------|
| \`all-unresolved-classified.csv\` | Full unresolved EP classification |
| \`safe-map-bridge-class-b.csv\` | Safe map insert candidates |
| \`manual-review-class-d.csv\` | Operator review queue |
| \`blocked-product-create-class-c.csv\` | Blocked until governed seed |
| \`sample-wave-class-a-ep-backfill.csv\` | Max-25 Wave 1 apply list |
| \`sample-wave-class-b-map-bridge.csv\` | Max-25 Wave 2 apply list |
`;

  fs.writeFileSync(path.join(outDir, "plan-report.md"), report);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit_id: "PRODUCT-LINKAGE-PHASE1-UNRESOLVED-EXPECTED-PACKAGES-PLAN",
        run_id: runId,
        mode: "read-only",
        staging_ref: STAGING_REF,
        expected_packages: s,
        linkage_classification: classCounts,
        identifier_buckets: idBuckets,
        scanner_impact: scan,
        claims_impact: claims,
        class_c_sub_buckets: cSub,
        sample_wave: { class_a: sampleClassA.length, class_b: sampleClassB.length },
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
