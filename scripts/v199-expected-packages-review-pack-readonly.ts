/**
 * V199 — EXPECTED_PACKAGES IDENTIFIER + AMBIGUOUS REVIEW PACK (read-only)
 *
 *   npx tsx scripts/v199-expected-packages-review-pack-readonly.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/v199-expected-identifier-ambiguous-review-pack";

type ReviewRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  order_id: string | null;
  tracking_number: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  disposition: string | null;
  build_source: string | null;
  resolved_product_id: string | null;
  identifier_resolution_status: string | null;
  read_bucket: string;
  map_distinct_product_ids: string[];
  map_fnsku_product_count: number;
  map_sku_product_count: number;
  trusted_source_product_count: number;
  trusted_sample_product_name: string | null;
  trusted_sample_asin: string | null;
  trusted_source_tables: string[] | null;
  trusted_source_row_ids: string[] | null;
  trusted_single_product_id: string | null;
  detail_asin: string | null;
  legacy_product_id: string | null;
  classification: string;
  recommended_action: string;
  source_evidence: string;
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

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function isDirtyTest(row: ReviewRow): boolean {
  const sku = (row.sku ?? "").toUpperCase();
  const fnsku = (row.fnsku ?? "").toUpperCase();
  const tracking = (row.tracking_number ?? "").toUpperCase();
  const order = (row.order_id ?? "").toUpperCase();
  if (!row.store_id) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN|N\/A|NA|NULL|XXX)/.test(sku)) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN)/.test(fnsku)) return true;
  if (/TEST|DUMMY|PLACEHOLDER/.test(tracking) || /TEST|DUMMY/.test(order)) return true;
  if (sku && fnsku && sku === fnsku && sku.length < 6) return true;
  if (fnsku && !/^[XB][0-9A-Z]{9,}$/i.test(fnsku) && fnsku.length < 5) return true;
  return false;
}

function hasAnyIdentifier(row: ReviewRow): boolean {
  return !!(row.sku || row.fnsku || row.asin || row.upc || row.detail_asin);
}

function apiEvidenceEligible(row: ReviewRow): boolean {
  if (!row.store_id || !row.organization_id) return false;
  const asin = row.asin ?? row.detail_asin ?? row.trusted_sample_asin;
  return !!asin && /^B[0-9A-Z]{9}$/i.test(asin.trim());
}

function classifyRow(row: ReviewRow): { classification: string; recommended_action: string; source_evidence: string } {
  const mapIds = row.map_distinct_product_ids;
  const mapAmbiguous =
    row.read_bucket === "ambiguous" ||
    mapIds.length > 1 ||
    row.map_fnsku_product_count > 1 ||
    row.map_sku_product_count > 1;

  if (isDirtyTest(row)) {
    return {
      classification: "dirty_test_invalid",
      recommended_action: "quarantine_or_fix_source_row",
      source_evidence: `build_source=${row.build_source ?? ""}; identifiers may be test/placeholder`,
    };
  }

  if (!hasAnyIdentifier(row)) {
    return {
      classification: "missing_identifiers",
      recommended_action: "enrich_from_source_detail_or_manual_entry",
      source_evidence: "no sku/fnsku/asin/upc on expected_packages or linked removal detail",
    };
  }

  if (mapAmbiguous) {
    return {
      classification: "ambiguous_multiple_products",
      recommended_action: "manual_pick_product_or_merge_map_rows",
      source_evidence: `map_candidate_product_ids=${mapIds.join("|") || "none"}`,
    };
  }

  if (
    row.trusted_source_product_count === 1 &&
    row.trusted_single_product_id &&
    mapIds.length === 0 &&
    !row.resolved_product_id
  ) {
    return {
      classification: "e1b_trusted_existing_product_map_missing",
      recommended_action: "insert_governed_map_bridge_only",
      source_evidence: `trusted_product_id=${row.trusted_single_product_id}; sources=${(row.trusted_source_tables ?? []).join(",")}`,
    };
  }

  if (row.trusted_source_product_count > 1) {
    return {
      classification: "source_data_inconsistency",
      recommended_action: "reconcile_imported_sources_before_link",
      source_evidence: `distinct_trusted_source_products=${row.trusted_source_product_count}`,
    };
  }

  if (row.trusted_sample_product_name && row.trusted_source_product_count === 0 && mapIds.length === 0) {
    return {
      classification: "trusted_name_only_no_product_id",
      recommended_action: "e2_style_product_promotion_if_approved_or_api_if_asin",
      source_evidence: `sample_name=${row.trusted_sample_product_name.slice(0, 80)}`,
    };
  }

  if (apiEvidenceEligible(row)) {
    return {
      classification: "api_evidence_needed",
      recommended_action: "governed_amazon_catalog_api_evidence_request",
      source_evidence: `asin=${row.asin ?? row.detail_asin ?? row.trusted_sample_asin}`,
    };
  }

  return {
    classification: "identifier_manual_review",
    recommended_action: "operator_review_identifiers_and_imports",
    source_evidence: `sku=${row.sku ?? ""}; fnsku=${row.fnsku ?? ""}; asin=${row.asin ?? row.detail_asin ?? ""}`,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const url = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(url) || refFromSupabaseUrl(dbUrl);

  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      "# Blockers\n\n**FAIL:** staging ref guard — set `STAGING_DIRECT_POSTGRES_URL` for ref `eiqfaapyumhixxoeltgu`.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "FAIL", error: "staging_ref_guard" }, null, 2),
    );
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '180s'`);

  const pkgItems = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
  );
  if ((pkgItems.rowCount ?? 0) > 0) {
    await client.end();
    fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\n**FAIL:** `package_items` exists (forbidden).\n");
    process.exit(2);
  }

  const colRes = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='expected_packages'`,
  );
  const epCols = new Set(colRes.rows.map((r: { column_name: string }) => r.column_name));
  const hasAsinCol = epCols.has("asin");
  const hasUpcCol = epCols.has("upc") || epCols.has("upc_code");
  const asinExpr = hasAsinCol ? "NULLIF(TRIM(e.asin), '')" : "NULL::text";
  const upcExpr = epCols.has("upc")
    ? "NULLIF(TRIM(e.upc), '')"
    : epCols.has("upc_code")
      ? "NULLIF(TRIM(e.upc_code), '')"
      : "NULL::text";
  const missingIdPred = [
    "ep.sku IS NULL",
    "ep.fnsku IS NULL",
    "ep.asin IS NULL",
    hasUpcCol ? "ep.upc IS NULL" : null,
  ]
    .filter(Boolean)
    .join(" AND ");

  const coverageRes = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku,
        ${asinExpr} AS asin,
        ${upcExpr} AS upc,
        e.resolved_product_id,
        e.identifier_resolution_status
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'direct_resolved'
          WHEN COALESCE(mf.product_count, 0) = 1 THEN 'read_layer_map_fnsku'
          WHEN COALESCE(ms.product_count, 0) = 1 THEN 'read_layer_map_sku'
          WHEN COALESCE(mf.product_count, 0) > 1 OR COALESCE(ms.product_count, 0) > 1 THEN 'ambiguous'
          WHEN ${missingIdPred} THEN 'missing_identifiers'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket IN ('direct_resolved','read_layer_map_fnsku','read_layer_map_sku'))::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket = 'unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket = 'ambiguous')::int AS ambiguous,
      COUNT(*) FILTER (WHERE bucket = 'missing_identifiers')::int AS missing_identifiers,
      COUNT(*) FILTER (WHERE bucket = 'direct_resolved')::int AS persisted_resolved
    FROM classified
  `);
  const coverage = coverageRes.rows[0] as Record<string, number>;

  const detailRes = await client.query(`
    WITH ep AS (
      SELECT
        e.id,
        e.organization_id,
        e.store_id,
        NULLIF(TRIM(e.order_id), '') AS order_id,
        NULLIF(TRIM(e.tracking_number), '') AS tracking_number,
        NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku,
        ${asinExpr} AS asin,
        ${upcExpr} AS upc,
        NULLIF(TRIM(e.disposition), '') AS disposition,
        NULLIF(TRIM(e.build_source), '') AS build_source,
        e.resolved_product_id,
        e.identifier_resolution_status,
        ${epCols.has("product_id") ? "e.product_id" : "NULL::uuid"} AS legacy_product_id,
        ${epCols.has("source_detail_row_id") ? "e.source_detail_row_id" : "NULL::uuid"} AS source_detail_row_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    detail_asin AS (
      SELECT ep.id, NULL::text AS detail_asin
      FROM ep
    ),
    trusted_sources AS (
      SELECT ep.id,
        COUNT(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL)::int AS source_product_count,
        COUNT(*) FILTER (WHERE product_name IS NOT NULL)::int AS source_rows_with_name,
        MIN(product_name) FILTER (WHERE product_name IS NOT NULL) AS sample_product_name,
        MIN(source_asin) FILTER (WHERE source_asin IS NOT NULL) AS sample_asin,
        ARRAY_AGG(DISTINCT src) FILTER (WHERE src IS NOT NULL) AS source_tables,
        ARRAY_AGG(DISTINCT source_row_id) FILTER (WHERE source_row_id IS NOT NULL) AS source_row_ids,
        (ARRAY_AGG(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL))[1] AS single_product_id
      FROM ep
      LEFT JOIN LATERAL (
        SELECT 'amazon_amazon_fulfilled_inventory'::text AS src, a.id::text AS source_row_id,
          COALESCE(a.resolved_product_id, a.product_id) AS source_product_id,
          NULL::text AS product_name, NULLIF(TRIM(a.asin), '') AS source_asin
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE a.organization_id = ep.organization_id AND a.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND a.fulfillment_channel_sku = ep.fnsku)
            OR (ep.sku IS NOT NULL AND a.seller_sku = ep.sku))
        UNION ALL
        SELECT 'amazon_fba_inventory'::text, f.id::text, COALESCE(f.resolved_product_id, f.product_id),
          NULLIF(TRIM(f.product_name), ''), NULLIF(TRIM(f.asin), '')
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id = ep.organization_id AND f.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND f.fnsku = ep.fnsku) OR (ep.sku IS NOT NULL AND f.sku = ep.sku))
        UNION ALL
        SELECT 'amazon_manage_fba_inventory'::text, mf.id::text, COALESCE(mf.resolved_product_id, mf.product_id),
          NULLIF(TRIM(mf.product_name), ''), NULLIF(TRIM(mf.asin), '')
        FROM public.amazon_manage_fba_inventory mf
        WHERE mf.organization_id = ep.organization_id AND mf.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND mf.fnsku = ep.fnsku) OR (ep.sku IS NOT NULL AND mf.sku = ep.sku))
      ) s ON true
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.*, da.detail_asin,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'direct_resolved'
          WHEN COALESCE(mf.product_count, 0) = 1 THEN 'read_layer_map_fnsku'
          WHEN COALESCE(ms.product_count, 0) = 1 THEN 'read_layer_map_sku'
          WHEN COALESCE(mf.product_count, 0) > 1 OR COALESCE(ms.product_count, 0) > 1 THEN 'ambiguous'
          WHEN ${missingIdPred} THEN 'missing_identifiers'
          ELSE 'unresolved'
        END AS read_bucket,
        COALESCE(mf.product_count, 0) AS map_fnsku_product_count,
        COALESCE(ms.product_count, 0) AS map_sku_product_count,
        (
          SELECT ARRAY(
            SELECT DISTINCT x FROM unnest(
              COALESCE(mf.product_ids, ARRAY[]::text[]) || COALESCE(ms.product_ids, ARRAY[]::text[])
            ) x ORDER BY x
          )
        ) AS map_distinct_product_ids,
        ts.source_product_count AS trusted_source_product_count,
        ts.sample_product_name AS trusted_sample_product_name,
        ts.sample_asin AS trusted_sample_asin,
        ts.source_tables AS trusted_source_tables,
        ts.source_row_ids AS trusted_source_row_ids,
        CASE WHEN ts.source_product_count = 1 THEN ts.single_product_id::text ELSE NULL END AS trusted_single_product_id
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
      LEFT JOIN detail_asin da ON da.id = ep.id
      LEFT JOIN trusted_sources ts ON ts.id = ep.id
    )
    SELECT * FROM classified
    WHERE read_bucket NOT IN ('direct_resolved', 'read_layer_map_fnsku', 'read_layer_map_sku')
    ORDER BY read_bucket, sku, fnsku, id
  `);

  await client.end();

  const rawRows = detailRes.rows as Record<string, unknown>[];
  const reviewRows: ReviewRow[] = rawRows.map((r) => {
    const base: ReviewRow = {
      expected_package_id: String(r.id),
      organization_id: String(r.organization_id),
      store_id: r.store_id ? String(r.store_id) : null,
      order_id: r.order_id ? String(r.order_id) : null,
      tracking_number: r.tracking_number ? String(r.tracking_number) : null,
      sku: r.sku ? String(r.sku) : null,
      fnsku: r.fnsku ? String(r.fnsku) : null,
      asin: r.asin ? String(r.asin) : null,
      upc: r.upc ? String(r.upc) : null,
      disposition: r.disposition ? String(r.disposition) : null,
      build_source: r.build_source ? String(r.build_source) : null,
      resolved_product_id: r.resolved_product_id ? String(r.resolved_product_id) : null,
      identifier_resolution_status: r.identifier_resolution_status
        ? String(r.identifier_resolution_status)
        : null,
      read_bucket: String(r.read_bucket),
      map_distinct_product_ids: Array.isArray(r.map_distinct_product_ids)
        ? (r.map_distinct_product_ids as string[])
        : [],
      map_fnsku_product_count: Number(r.map_fnsku_product_count ?? 0),
      map_sku_product_count: Number(r.map_sku_product_count ?? 0),
      trusted_source_product_count: Number(r.trusted_source_product_count ?? 0),
      trusted_sample_product_name: r.trusted_sample_product_name
        ? String(r.trusted_sample_product_name)
        : null,
      trusted_sample_asin: r.trusted_sample_asin ? String(r.trusted_sample_asin) : null,
      trusted_source_tables: Array.isArray(r.trusted_source_tables)
        ? (r.trusted_source_tables as string[])
        : null,
      trusted_source_row_ids: Array.isArray(r.trusted_source_row_ids)
        ? (r.trusted_source_row_ids as string[])
        : null,
      trusted_single_product_id: r.trusted_single_product_id
        ? String(r.trusted_single_product_id)
        : null,
      detail_asin: r.detail_asin ? String(r.detail_asin) : null,
      legacy_product_id: r.legacy_product_id ? String(r.legacy_product_id) : null,
      classification: "",
      recommended_action: "",
      source_evidence: "",
    };
    const c = classifyRow(base);
    return { ...base, ...c };
  });

  const byClass = new Map<string, ReviewRow[]>();
  for (const row of reviewRows) {
    const list = byClass.get(row.classification) ?? [];
    list.push(row);
    byClass.set(row.classification, list);
  }

  const apiCohort = reviewRows.filter((r) => r.classification === "api_evidence_needed");
  const ambiguousRows = reviewRows.filter(
    (r) =>
      r.classification === "ambiguous_multiple_products" ||
      r.classification === "source_data_inconsistency",
  );
  const dirtyRows = reviewRows.filter((r) => r.classification === "dirty_test_invalid");

  const csvHeader = [
    "expected_package_id",
    "organization_id",
    "store_id",
    "fnsku",
    "sku",
    "asin",
    "upc",
    "read_bucket",
    "classification",
    "candidate_product_ids",
    "trusted_single_product_id",
    "source_evidence",
    "recommended_action",
  ];
  const csvLines = [
    csvHeader.join(","),
    ...reviewRows.map((r) =>
      [
        r.expected_package_id,
        r.organization_id,
        r.store_id,
        r.fnsku,
        r.sku,
        r.asin ?? r.detail_asin,
        r.upc,
        r.read_bucket,
        r.classification,
        r.map_distinct_product_ids.join(";"),
        r.trusted_single_product_id,
        r.source_evidence,
        r.recommended_action,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  fs.writeFileSync(path.join(outDir, "manual-review-queue.csv"), csvLines.join("\n") + "\n", "utf8");

  fs.writeFileSync(
    path.join(outDir, "api-evidence-cohort.json"),
    JSON.stringify(
      {
        run_id: runId,
        staging_ref: STAGING_REF,
        count: apiCohort.length,
        note: "Governed Amazon catalog API evidence only — no API calls in V199.",
        approval_file: ".cursor/operator-approvals/expected-packages-amazon-api-enrichment-v194-approval.md",
        rows: apiCohort.map((r) => ({
          expected_package_id: r.expected_package_id,
          organization_id: r.organization_id,
          store_id: r.store_id,
          asin: r.asin ?? r.detail_asin ?? r.trusted_sample_asin,
          fnsku: r.fnsku,
          sku: r.sku,
          upc: r.upc,
          recommended_action: r.recommended_action,
          source_evidence: r.source_evidence,
        })),
      },
      null,
      2,
    ),
  );

  const mapAmbiguous = ambiguousRows.filter((r) => r.classification === "ambiguous_multiple_products");
  const sourceAmbiguous = ambiguousRows.filter((r) => r.classification === "source_data_inconsistency");
  const ambMd = [
    "# Ambiguous candidates",
    "",
    `**Total for manual review:** ${ambiguousRows.length}`,
    `- Map-tier ambiguous (multiple \`product_id\` on FNSKU/SKU): **${mapAmbiguous.length}**`,
    `- Trusted-source disagreement (multiple source product ids): **${sourceAmbiguous.length}**`,
    "",
    "## Map-tier ambiguous",
    "",
    mapAmbiguous.length
      ? [
          "| expected_package_id | fnsku | sku | candidate_product_ids |",
          "|---|---|---|---|",
          ...mapAmbiguous.map(
            (r) =>
              `| \`${r.expected_package_id}\` | ${r.fnsku ?? "—"} | ${r.sku ?? "—"} | ${r.map_distinct_product_ids.join(", ") || "—"} |`,
          ),
        ].join("\n")
      : "_None at FNSKU/SKU map tier after E1/E2 (V196 same-product collapse may apply at read time)._",
    "",
    "## Trusted-source disagreement",
    "",
    sourceAmbiguous.length
      ? [
          "| expected_package_id | fnsku | sku | trusted_source_product_count |",
          "|---|---|---|---|",
          ...sourceAmbiguous.map(
            (r) =>
              `| \`${r.expected_package_id}\` | ${r.fnsku ?? "—"} | ${r.sku ?? "—"} | ${r.trusted_source_product_count} |`,
          ),
        ].join("\n")
      : "_None._",
  ];
  fs.writeFileSync(path.join(outDir, "ambiguous-candidates.md"), ambMd.join("\n") + "\n");

  const dirtyMd = [
    "# Dirty / invalid / test rows",
    "",
    `**Count:** ${dirtyRows.length}`,
    "",
    "Heuristic flags: missing `store_id`, placeholder SKUs/FNSKUs, test tracking/order tokens.",
    "",
    "| expected_package_id | store_id | sku | fnsku | build_source | action |",
    "|---|---|---|---|---|---|",
    ...dirtyRows.map(
      (r) =>
        `| \`${r.expected_package_id}\` | ${r.store_id ?? "NULL"} | ${r.sku ?? "—"} | ${r.fnsku ?? "—"} | ${r.build_source ?? "—"} | ${r.recommended_action} |`,
    ),
  ];
  fs.writeFileSync(path.join(outDir, "dirty-invalid-rows.md"), dirtyMd.join("\n") + "\n");

  const e1bCount = byClass.get("e1b_trusted_existing_product_map_missing")?.length ?? 0;
  const summaryMd = [
    "# Remaining unresolved summary (V199)",
    "",
    `**Run id:** \`${runId}\``,
    `**Staging ref:** \`${STAGING_REF}\``,
    `**Probed:** ${new Date().toISOString()}`,
    "",
    "## Read-layer coverage (post E1 / E2 / E1B map work)",
    "",
    "| Metric | Count |",
    "|--------|------:|",
    `| Total \`expected_packages\` | ${coverage.total ?? 0} |`,
    `| Read-layer resolved (persisted or single map match) | ${coverage.read_layer_resolved ?? 0} |`,
    `| Persisted \`resolved_product_id\` only | ${coverage.persisted_resolved ?? 0} |`,
    `| Remaining unresolved (SQL bucket) | ${coverage.unresolved ?? 0} |`,
    `| Ambiguous (SQL bucket) | ${coverage.ambiguous ?? 0} |`,
    `| Missing identifiers (SQL bucket) | ${coverage.missing_identifiers ?? 0} |`,
    `| **Review queue rows (unresolved + ambiguous + missing)** | **${reviewRows.length}** |`,
    "",
    "## V199 classification (review queue)",
    "",
    "| Classification | Count |",
    "|----------------|------:|",
    ...[...byClass.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k, v]) => `| ${k} | ${v.length} |`),
    "",
    "## Prior plan alignment",
    "",
    `- API evidence cohort: **${apiCohort.length}** (prior plan ~46 identifier-only/API/manual)`,
    `- Ambiguous / source disagreement: **${ambiguousRows.length}** (prior plan ~6 map ambiguous; ${sourceAmbiguous.length} trusted-source conflicts)`,
    `- E1B map-missing (trusted existing product): **${e1bCount}** (prior plan ~28)`,
    `- Dirty/test/invalid: **${dirtyRows.length}**`,
    "",
    "## Notes",
    "",
    "- Read-layer uses FNSKU + SKU map tiers only in this SQL census (matches V192/V194 execute guards).",
    "- ASIN/UPC map tiers and V196 same-product_id collapse are **not** applied in SQL; ambiguous count may be conservative.",
    "- No DB writes, Amazon API, product creation, or map inserts in this run.",
  ];
  fs.writeFileSync(path.join(outDir, "remaining-unresolved-summary.md"), summaryMd.join("\n") + "\n");

  const blockers: string[] = [];
  if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push("- Staging URL ref mismatch on DB connection string.");
  }
  if ((coverage.unresolved ?? 0) + (coverage.ambiguous ?? 0) > 100) {
    blockers.push(
      `- Review queue larger than prior ~80 estimate (${reviewRows.length} rows) — re-verify after any new E1B execute.`,
    );
  }
  if (apiCohort.length === 0 && (coverage.unresolved ?? 0) > 0) {
    blockers.push("- API evidence cohort empty while unresolved rows exist — check ASIN availability on rows.");
  }

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      blockers.length ? blockers.join("\n") : "- None blocking read-only pack generation.",
      "",
      "## Operator gates (not executed here)",
      "",
      "- `expected-packages-e1-map-bridge-v192` — map-only inserts",
      "- `expected-packages-e2-product-promotion-v194` — trusted-name product promotion",
      "- `expected-packages-amazon-api-enrichment-v194` — governed API evidence (flag was misspelled `ture` in prior run)",
      "",
      "## Next prompt",
      "",
      "See manifest `next_prompt`.",
    ].join("\n") + "\n",
  );

  const nextPrompt = `EXPECTED-PACKAGES-E1B-MAP-BRIDGE-EXECUTE — insert governed product_identifier_map rows for ${e1bCount} trusted-existing-product rows (classification e1b_trusted_existing_product_map_missing) from V199 pack ${runId}; then EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-DRY-RUN for ${apiCohort.length} ASIN rows with APPROVED_EXPECTED_PACKAGES_AMAZON_API_ENRICHMENT_V194=true; manual review ${sourceAmbiguous.length} source-disagreement + ${mapAmbiguous.length} map-ambiguous rows and ${byClass.get("identifier_manual_review")?.length ?? 0} identifier-only rows via manual-review-queue.csv.`;

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "V199 — EXPECTED_PACKAGES IDENTIFIER + AMBIGUOUS REVIEW PACK",
        run_id: runId,
        status: "PASS",
        staging_ref: STAGING_REF,
        read_only: true,
        coverage,
        review_queue_count: reviewRows.length,
        counts: {
          api_evidence: apiCohort.length,
          ambiguous_map_tier: mapAmbiguous.length,
          ambiguous_source_disagreement: sourceAmbiguous.length,
          ambiguous_total: ambiguousRows.length,
          dirty_invalid: dirtyRows.length,
          e1b_map_missing: e1bCount,
          missing_identifiers: byClass.get("missing_identifiers")?.length ?? 0,
          source_inconsistency: byClass.get("source_data_inconsistency")?.length ?? 0,
          identifier_manual_review: byClass.get("identifier_manual_review")?.length ?? 0,
          trusted_name_only: byClass.get("trusted_name_only_no_product_id")?.length ?? 0,
        },
        artifacts: [
          "remaining-unresolved-summary.md",
          "manual-review-queue.csv",
          "api-evidence-cohort.json",
          "ambiguous-candidates.md",
          "dirty-invalid-rows.md",
          "blockers.md",
          "manifest.json",
        ],
        next_prompt: nextPrompt,
        forbidden: {
          db_mutations: false,
          amazon_api: false,
          product_creation: false,
          map_inserts: false,
          production: false,
        },
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        run_id: runId,
        outDir,
        api_evidence: apiCohort.length,
        ambiguous_total: ambiguousRows.length,
        ambiguous_source_disagreement: sourceAmbiguous.length,
        dirty_invalid: dirtyRows.length,
        review_queue: reviewRows.length,
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
