/**
 * EXPECTED-PACKAGES-REMAINING-52-REVIEW-EXECUTE-V201
 * Read-only triage of remaining unresolved expected_packages on staging.
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
const V199_PACK =
  ".cursor/audit-reports/v199-expected-identifier-ambiguous-review-pack/20260522T130000Z";
const V200_MANIFEST =
  ".cursor/audit-reports/expected-packages-e1b-blocker-materialize-execute-v200/20260522T160000Z/manifest.json";
const OUT_BASE = ".cursor/audit-reports/expected-packages-remaining-52-review-v201";

type ReviewRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  build_source: string | null;
  resolved_product_id: string | null;
  read_bucket: string;
  map_distinct_product_ids: string[];
  map_fnsku_product_count: number;
  map_sku_product_count: number;
  trusted_source_product_count: number;
  trusted_sample_product_name: string | null;
  trusted_sample_asin: string | null;
  trusted_source_tables: string[] | null;
  trusted_single_product_id: string | null;
  detail_asin: string | null;
  classification: string;
  recommended_action: string;
  source_evidence: string;
  wave: string;
  next_execute_prompt: string;
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
  if (!row.store_id) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN)/.test(sku) || /^(TEST|DUMMY)/.test(fnsku)) return true;
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

function classifyRow(row: ReviewRow): Pick<ReviewRow, "classification" | "recommended_action" | "source_evidence"> {
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
      source_evidence: `build_source=${row.build_source ?? ""}`,
    };
  }
  if (!hasAnyIdentifier(row)) {
    return {
      classification: "missing_identifiers",
      recommended_action: "enrich_from_source_detail_or_manual_entry",
      source_evidence: "no sku/fnsku/asin/upc",
    };
  }
  if (mapAmbiguous) {
    return {
      classification: "ambiguous_multiple_products",
      recommended_action: "manual_pick_product_or_merge_map_rows",
      source_evidence: `map_ids=${mapIds.join("|")}`,
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
      source_evidence: `trusted_product_id=${row.trusted_single_product_id}`,
    };
  }
  if (row.trusted_source_product_count > 1) {
    return {
      classification: "source_data_inconsistency",
      recommended_action: "reconcile_imported_sources_before_link",
      source_evidence: `distinct_trusted=${row.trusted_source_product_count}`,
    };
  }
  if (row.trusted_sample_product_name && row.trusted_source_product_count === 0 && mapIds.length === 0) {
    return {
      classification: "trusted_name_only_no_product_id",
      recommended_action: "e2_style_product_promotion_if_approved",
      source_evidence: `name=${row.trusted_sample_product_name.slice(0, 60)}`,
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
    source_evidence: `sku=${row.sku ?? ""}; fnsku=${row.fnsku ?? ""}`,
  };
}

function assignWave(row: ReviewRow): { wave: string; next_execute_prompt: string } {
  switch (row.classification) {
    case "api_evidence_needed":
      return {
        wave: "wave_1_api_evidence_gated",
        next_execute_prompt:
          "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-DRY-RUN-V202 — fix API approval spelling; gated SP-API catalog evidence only",
      };
    case "source_data_inconsistency":
      return {
        wave: "wave_2_source_reconcile_manual",
        next_execute_prompt:
          "EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE-PLAN-V202 — operator picks canonical import product_id per FNSKU cluster",
      };
    case "trusted_name_only_no_product_id":
      return {
        wave: "wave_3_e2_style_promotion_candidate",
        next_execute_prompt:
          "EXPECTED-PACKAGES-E2-SUPPLEMENTAL-PROMOTION-PLAN-V202 — governed product+map from trusted import name (separate approval)",
      };
    case "e1b_trusted_existing_product_map_missing":
      return {
        wave: "wave_0_e1b_residual",
        next_execute_prompt:
          "EXPECTED-PACKAGES-E1B-MAP-ONLY-REFRESH-EXECUTE-V198 — residual after V200; verify spine",
      };
    case "ambiguous_multiple_products":
      return {
        wave: "wave_2_map_ambiguous_manual",
        next_execute_prompt: "EXPECTED-PACKAGES-MAP-AMBIGUOUS-MANUAL-QUEUE-V202",
      };
    case "dirty_test_invalid":
      return {
        wave: "wave_4_quarantine",
        next_execute_prompt: "EXPECTED-PACKAGES-DIRTY-TEST-QUARANTINE-V202",
      };
    case "missing_identifiers":
      return {
        wave: "wave_4_identifier_enrichment",
        next_execute_prompt: "EXPECTED-PACKAGES-IDENTIFIER-ENRICHMENT-MANUAL-V202",
      };
    default: {
      const sub =
        row.trusted_sample_product_name && row.trusted_source_product_count === 0
          ? "trusted_import_no_spine_hit"
          : row.map_distinct_product_ids.length === 0
            ? "no_map_no_trusted_source"
            : "identifier_only_stale";
      return {
        wave: `wave_3_identifier_manual_${sub}`,
        next_execute_prompt:
          "EXPECTED-PACKAGES-IDENTIFIER-MANUAL-REVIEW-BATCH-V202 — operator queue from remaining-52-triage.csv",
      };
    }
  }
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
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku,
        ${asinExpr} AS asin, ${upcExpr} AS upc, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
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
      COUNT(*) FILTER (WHERE bucket = 'missing_identifiers')::int AS missing_identifiers
    FROM classified
  `);

  const detailRes = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku,
        ${asinExpr} AS asin, ${upcExpr} AS upc,
        NULLIF(TRIM(e.build_source), '') AS build_source, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    trusted_sources AS (
      SELECT ep.id,
        COUNT(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL)::int AS source_product_count,
        MIN(product_name) FILTER (WHERE product_name IS NOT NULL) AS sample_product_name,
        MIN(source_asin) FILTER (WHERE source_asin IS NOT NULL) AS sample_asin,
        ARRAY_AGG(DISTINCT src) FILTER (WHERE src IS NOT NULL) AS source_tables,
        (ARRAY_AGG(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL))[1] AS single_product_id
      FROM ep
      LEFT JOIN LATERAL (
        SELECT 'amazon_amazon_fulfilled_inventory'::text AS src,
          COALESCE(a.resolved_product_id, a.product_id) AS source_product_id,
          NULL::text AS product_name, NULLIF(TRIM(a.asin), '') AS source_asin
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE a.organization_id = ep.organization_id AND a.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND a.fulfillment_channel_sku = ep.fnsku)
            OR (ep.sku IS NOT NULL AND a.seller_sku = ep.sku))
        UNION ALL
        SELECT 'amazon_fba_inventory'::text, COALESCE(f.resolved_product_id, f.product_id),
          NULLIF(TRIM(f.product_name), ''), NULLIF(TRIM(f.asin), '')
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id = ep.organization_id AND f.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND f.fnsku = ep.fnsku) OR (ep.sku IS NOT NULL AND f.sku = ep.sku))
        UNION ALL
        SELECT 'amazon_manage_fba_inventory'::text, COALESCE(mf.resolved_product_id, mf.product_id),
          NULLIF(TRIM(mf.product_name), ''), NULLIF(TRIM(mf.asin), '')
        FROM public.amazon_manage_fba_inventory mf
        WHERE mf.organization_id = ep.organization_id AND mf.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND mf.fnsku = ep.fnsku) OR (ep.sku IS NOT NULL AND mf.sku = ep.sku))
      ) s ON true
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.*,
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
        (SELECT ARRAY(SELECT DISTINCT x FROM unnest(
          COALESCE(mf.product_ids, ARRAY[]::text[]) || COALESCE(ms.product_ids, ARRAY[]::text[])
        ) x ORDER BY x)) AS map_distinct_product_ids,
        ts.source_product_count AS trusted_source_product_count,
        ts.sample_product_name AS trusted_sample_product_name,
        ts.sample_asin AS trusted_sample_asin,
        ts.source_tables AS trusted_source_tables,
        CASE WHEN ts.source_product_count = 1 THEN ts.single_product_id::text ELSE NULL END AS trusted_single_product_id,
        NULL::text AS detail_asin
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
      LEFT JOIN trusted_sources ts ON ts.id = ep.id
    )
    SELECT * FROM classified
    WHERE read_bucket = 'unresolved'
    ORDER BY fnsku, sku, id
  `);

  await client.end();

  const coverage = coverageRes.rows[0] as Record<string, number>;
  const rows: ReviewRow[] = (detailRes.rows as Record<string, unknown>[]).map((r) => {
    const base: ReviewRow = {
      expected_package_id: String(r.id),
      organization_id: String(r.organization_id),
      store_id: r.store_id ? String(r.store_id) : null,
      sku: r.sku ? String(r.sku) : null,
      fnsku: r.fnsku ? String(r.fnsku) : null,
      asin: r.asin ? String(r.asin) : null,
      upc: r.upc ? String(r.upc) : null,
      build_source: r.build_source ? String(r.build_source) : null,
      resolved_product_id: r.resolved_product_id ? String(r.resolved_product_id) : null,
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
      trusted_single_product_id: r.trusted_single_product_id
        ? String(r.trusted_single_product_id)
        : null,
      detail_asin: null,
      classification: "",
      recommended_action: "",
      source_evidence: "",
      wave: "",
      next_execute_prompt: "",
    };
    const c = classifyRow(base);
    const w = assignWave({ ...base, ...c });
    return { ...base, ...c, ...w };
  });

  const byClass = new Map<string, ReviewRow[]>();
  const byWave = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    (byClass.get(row.classification) ?? byClass.set(row.classification, []).get(row.classification)!).push(
      row,
    );
    (byWave.get(row.wave) ?? byWave.set(row.wave, []).get(row.wave)!).push(row);
  }

  const v199Expected = {
    api_evidence: 8,
    source_inconsistency: 6,
    identifier_manual_review: 38,
    total: 52,
  };

  const matrix = {
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only_triage",
    inputs: { v199_pack: V199_PACK, v200_manifest: V200_MANIFEST },
    live_coverage: coverage,
    row_count: rows.length,
    v199_expected_counts: v199Expected,
    classification_counts: Object.fromEntries([...byClass].map(([k, v]) => [k, v.length])),
    wave_counts: Object.fromEntries([...byWave].map(([k, v]) => [k, v.length])),
    rows,
  };

  fs.writeFileSync(path.join(outDir, "remaining-52-matrix.json"), JSON.stringify(matrix, null, 2));

  const csvHeader = [
    "expected_package_id",
    "fnsku",
    "sku",
    "asin",
    "classification",
    "wave",
    "trusted_source_product_count",
    "map_candidate_ids",
    "next_execute_prompt",
  ];
  fs.writeFileSync(
    path.join(outDir, "remaining-52-triage.csv"),
    [
      csvHeader.join(","),
      ...rows.map((r) =>
        [
          r.expected_package_id,
          r.fnsku,
          r.sku,
          r.asin,
          r.classification,
          r.wave,
          r.trusted_source_product_count,
          r.map_distinct_product_ids.join(";"),
          r.next_execute_prompt,
        ]
          .map(csvEscape)
          .join(","),
      ),
    ].join("\n") + "\n",
  );

  const waveLines = [...byWave.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([wave, list]) => `- **${wave}** — ${list.length} rows → \`${list[0]?.next_execute_prompt.split("—")[0]?.trim()}\``);

  fs.writeFileSync(
    path.join(outDir, "triage-plan.md"),
    [
      "# Expected packages — remaining 52 triage (V201)",
      "",
      `**Run id:** \`${runId}\``,
      `**Staging ref:** \`${STAGING_REF}\``,
      `**Mode:** read-only (no DB writes)`,
      "",
      "## Live coverage (post V200)",
      "",
      "| Metric | V199 pack | Live now |",
      "|--------|----------:|---------:|",
      `| Read-layer resolved | 1,546 | **${coverage.read_layer_resolved}** |`,
      `| Unresolved | 80 | **${coverage.unresolved}** |`,
      `| Ambiguous | 0 | **${coverage.ambiguous ?? 0}** |`,
      `| Triage rows probed | 80 queue | **${rows.length}** unresolved bucket |`,
      "",
      "## V199 alignment (52 = 38 + 8 + 6)",
      "",
      "| Classification | V199 | Live reclass |",
      "|----------------|-----:|-------------:|",
      `| identifier_manual_review | 38 | **${byClass.get("identifier_manual_review")?.length ?? 0}** |`,
      `| api_evidence_needed | 8 | **${byClass.get("api_evidence_needed")?.length ?? 0}** |`,
      `| source_data_inconsistency | 6 | **${byClass.get("source_data_inconsistency")?.length ?? 0}** |`,
      `| e1b residual | 0 expected | **${byClass.get("e1b_trusted_existing_product_map_missing")?.length ?? 0}** |`,
      `| trusted_name_only | 0 | **${byClass.get("trusted_name_only_no_product_id")?.length ?? 0}** |`,
      "",
      "## Governed next waves (priority order)",
      "",
      ...waveLines,
      "",
      "## Hard stops",
      "",
      "- No blind bulk product create",
      "- No `package_items`; no legacy `returns`",
      "- Amazon API only with fixed operator approval + env gates",
      "- No AI / title-OCR auto-create",
      "",
      "## Artifacts",
      "",
      "- `remaining-52-matrix.json`",
      "- `remaining-52-triage.csv`",
      "- `next-safe-waves.md`",
      "- `blockers.md`",
    ].join("\n") + "\n",
  );

  const nextSafe = [
    "# Next safe waves — remaining 52 (V201)",
    "",
    "## P0 — Gated API evidence (8 rows)",
    "",
    "Fix `.cursor/operator-approvals/expected-packages-amazon-api-enrichment-v194-approval.md` (`ture` typo).",
    "Then dry-run → execute governed catalog evidence for ASIN cohort only.",
    "",
    "**Prompt:** `EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-DRY-RUN-V202`",
    "",
    "## P1 — Source disagreement manual (6 rows)",
    "",
    "Clusters share FNSKU/SKU but multiple trusted import `product_id`s. Operator reconciles import rows, then map-only or materialize.",
    "",
    "**Prompt:** `EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE-PLAN-V202`",
    "",
    "## P2 — Identifier manual review (38 rows)",
    "",
    "Sub-waves from live probe:",
    `- trusted import name, no spine: **${byWave.get("wave_3_identifier_manual_trusted_import_no_spine_hit")?.length ?? 0}**`,
    `- no map, no trusted source: **${byWave.get("wave_3_identifier_manual_no_map_no_trusted_source")?.length ?? 0}**`,
    `- other identifier-only: **${byWave.get("wave_3_identifier_manual_identifier_only_stale")?.length ?? 0}**`,
    "",
    "**Prompt:** `EXPECTED-PACKAGES-IDENTIFIER-MANUAL-REVIEW-BATCH-V202`",
    "",
    "## Do not run yet",
    "",
    "- E2-style promotion without per-cohort approval",
    "- E1B map-only unless e1b residual count > 0",
    "- Settlement / ledger blind bulk",
  ];
  fs.writeFileSync(path.join(outDir, "next-safe-waves.md"), nextSafe.join("\n") + "\n");

  const blockers: string[] = [];
  if (rows.length !== 52) {
    blockers.push(
      `Live unresolved count **${rows.length}** differs from expected **52** after V200 (check classification drift).`,
    );
  }
  if ((byClass.get("e1b_trusted_existing_product_map_missing")?.length ?? 0) > 0) {
    blockers.push(
      `**${byClass.get("e1b_trusted_existing_product_map_missing")!.length}** e1b residual rows — verify V200 maps.`,
    );
  }
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? ["# Blockers / drift", "", ...blockers.map((b) => `- ${b}`)].join("\n") + "\n"
      : "# Blockers\n\nNone — live unresolved count matches post-V200 expectation.\n",
  );

  const topPrompt =
    (byClass.get("api_evidence_needed")?.length ?? 0) > 0
      ? "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-DRY-RUN-V202"
      : (byClass.get("source_data_inconsistency")?.length ?? 0) > 0
        ? "EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE-PLAN-V202"
        : "EXPECTED-PACKAGES-IDENTIFIER-MANUAL-REVIEW-BATCH-V202";

  const manifest = {
    prompt: "EXPECTED-PACKAGES-REMAINING-52-REVIEW-EXECUTE-V201",
    run_id: runId,
    staging_ref: STAGING_REF,
    status: blockers.length ? "PASS_WITH_NOTES" : "PASS",
    live_unresolved: rows.length,
    classification_counts: matrix.classification_counts,
    wave_counts: matrix.wave_counts,
    next_prompt: topPrompt,
    forbidden: {
      db_mutations: false,
      amazon_api: false,
      production: false,
    },
    artifacts: [
      "triage-plan.md",
      "remaining-52-matrix.json",
      "remaining-52-triage.csv",
      "next-safe-waves.md",
      "blockers.md",
      "manifest.json",
    ],
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
