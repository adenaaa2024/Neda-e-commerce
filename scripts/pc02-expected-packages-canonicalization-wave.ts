/**
 * PC02 — EXPECTED-PACKAGES-CANONICALIZATION-WAVE
 *
 * Read-only live wave for unresolved expected_packages on staging.
 * No DB writes, no Amazon API, no product/map inserts.
 *
 *   npx tsx scripts/pc02-expected-packages-canonicalization-wave.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { classifyProductBarcode } from "../lib/product-barcode-classify";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/pc02-expected-packages-canonicalization-wave";
const PC01_MANIFEST =
  ".cursor/audit-reports/pc01-product-canonicalization-baseline/20260522T230000Z/manifest.json";
const V202_MANUAL_MANIFEST =
  ".cursor/audit-reports/expected-packages-identifier-manual-review-batch-v202/20260522T220000Z/manifest.json";
const API_EXECUTE_DIR =
  ".cursor/audit-reports/expected-packages-amazon-api-evidence-execute-v202/20260522T210000Z";

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
  trusted_single_product_id: string | null;
  classification: string;
  pc02_wave: string;
  pc02_action: string;
  resolver_status: string | null;
  resolver_product_id: string | null;
  execute_ready: boolean;
  next_prompt: string;
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

function isDirtyIdentifier(row: Pick<ReviewRow, "sku" | "fnsku" | "store_id">): boolean {
  const sku = (row.sku ?? "").trim().toUpperCase();
  const fnsku = (row.fnsku ?? "").trim().toUpperCase();
  if (!row.store_id) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN|UNKNOW)$/i.test(sku)) return true;
  if (/^(TEST|DUMMY)$/i.test(fnsku)) return true;
  if (/^B[0-9A-Z]{9}$/.test(fnsku)) return true;
  return false;
}

function classifyRow(row: Omit<ReviewRow, "pc02_wave" | "pc02_action" | "resolver_status" | "resolver_product_id" | "execute_ready" | "next_prompt">): string {
  const mapIds = row.map_distinct_product_ids;
  const mapAmbiguous =
    mapIds.length > 1 || row.map_fnsku_product_count > 1 || row.map_sku_product_count > 1;

  if (isDirtyIdentifier(row)) return "dirty_source_identifiers";
  if (!row.sku && !row.fnsku && !row.asin && !row.upc) return "missing_identifiers";
  if (mapAmbiguous) return "ambiguous_multiple_products";
  if (
    row.trusted_source_product_count === 1 &&
    row.trusted_single_product_id &&
    mapIds.length === 0 &&
    !row.resolved_product_id
  ) {
    return "e1b_map_bridge_candidate";
  }
  if (row.trusted_source_product_count > 1) return "source_data_inconsistency";
  if (row.trusted_sample_product_name && row.trusted_source_product_count === 0 && mapIds.length === 0) {
    return "e2_promotion_candidate";
  }
  const asin = row.asin ?? row.trusted_sample_asin;
  if (asin && /^B[0-9A-Z]{9}$/i.test(asin.trim()) && row.store_id) return "api_evidence_candidate";
  return "identifier_manual_review";
}

function assignPc02Wave(classification: string, api404Ids: Set<string>, epId: string): {
  pc02_wave: string;
  pc02_action: string;
  execute_ready: boolean;
  next_prompt: string;
} {
  if (classification === "e1b_map_bridge_candidate") {
    return {
      pc02_wave: "wave_d_map_bridge",
      pc02_action: "governed_map_only_e1b",
      execute_ready: true,
      next_prompt: "PC02B — EXPECTED-PACKAGES-E1B-MAP-BRIDGE-EXECUTE",
    };
  }
  if (classification === "source_data_inconsistency") {
    return {
      pc02_wave: "wave_b_source_disagreement",
      pc02_action: "operator_reconcile_imports",
      execute_ready: false,
      next_prompt: "PC03 — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE",
    };
  }
  if (classification === "api_evidence_candidate" && api404Ids.has(epId)) {
    return {
      pc02_wave: "wave_c_api_catalog_404",
      pc02_action: "operator_verify_asin_or_pim_link",
      execute_ready: false,
      next_prompt: "PC02C — EXPECTED-PACKAGES-API-404-MANUAL-QUEUE",
    };
  }
  if (classification === "api_evidence_candidate") {
    return {
      pc02_wave: "wave_c_api_evidence",
      pc02_action: "governed_sp_api_evidence",
      execute_ready: false,
      next_prompt: "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE-V202 (re-review gates)",
    };
  }
  if (classification === "dirty_source_identifiers") {
    return {
      pc02_wave: "wave_a_dirty_source",
      pc02_action: "fix_source_identifiers_or_quarantine",
      execute_ready: false,
      next_prompt: "PC03 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN",
    };
  }
  if (classification === "e2_promotion_candidate") {
    return {
      pc02_wave: "wave_e_e2_promotion",
      pc02_action: "governed_e2_separate_approval",
      execute_ready: false,
      next_prompt: "EXPECTED-PACKAGES-E2-SUPPLEMENTAL-PROMOTION-PLAN",
    };
  }
  if (classification === "ambiguous_multiple_products") {
    return {
      pc02_wave: "wave_manual_ambiguous",
      pc02_action: "manual_pick_product",
      execute_ready: false,
      next_prompt: "EXPECTED-PACKAGES-MAP-AMBIGUOUS-MANUAL-QUEUE",
    };
  }
  return {
    pc02_wave: "wave_a_identifier_manual",
    pc02_action: "operator_pim_manual_link",
    execute_ready: false,
    next_prompt: "EXPECTED-PACKAGES-IDENTIFIER-MANUAL-REVIEW-BATCH-V202 (completed queue)",
  };
}

function loadApi404EpIds(): Set<string> {
  const p = path.join(process.cwd(), API_EXECUTE_DIR, "execute-lines.json");
  if (!fs.existsSync(p)) return new Set();
  const lines = JSON.parse(fs.readFileSync(p, "utf8")) as Array<{
    expected_package_ids: string[];
    outcome: string;
  }>;
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.outcome === "catalog_lookup_failed") {
      for (const id of line.expected_package_ids) ids.add(id);
    }
  }
  return ids;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key || refFromSupabaseUrl(url) !== STAGING_REF) {
    throw new Error("Staging Supabase guard failed");
  }

  const api404Ids = loadApi404EpIds();
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
      COUNT(*) FILTER (WHERE bucket = 'ambiguous')::int AS ambiguous
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
        (ARRAY_AGG(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL))[1] AS single_product_id
      FROM ep
      LEFT JOIN LATERAL (
        SELECT COALESCE(a.resolved_product_id, a.product_id) AS source_product_id,
          NULL::text AS product_name, NULLIF(TRIM(a.asin), '') AS source_asin
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE a.organization_id = ep.organization_id AND a.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND a.fulfillment_channel_sku = ep.fnsku)
            OR (ep.sku IS NOT NULL AND a.seller_sku = ep.sku))
        UNION ALL
        SELECT COALESCE(f.resolved_product_id, f.product_id),
          NULLIF(TRIM(f.product_name), ''), NULLIF(TRIM(f.asin), '')
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id = ep.organization_id AND f.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND f.fnsku = ep.fnsku) OR (ep.sku IS NOT NULL AND f.sku = ep.sku))
        UNION ALL
        SELECT COALESCE(mf.resolved_product_id, mf.product_id),
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
        CASE WHEN ts.source_product_count = 1 THEN ts.single_product_id::text ELSE NULL END AS trusted_single_product_id
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
      LEFT JOIN trusted_sources ts ON ts.id = ep.id
    )
    SELECT * FROM classified WHERE read_bucket = 'unresolved' ORDER BY fnsku, sku, id
  `);

  await client.end();

  const coverage = coverageRes.rows[0] as Record<string, number>;
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const rows: ReviewRow[] = [];

  for (const r of detailRes.rows as Record<string, unknown>[]) {
    const base = {
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
      trusted_single_product_id: r.trusted_single_product_id
        ? String(r.trusted_single_product_id)
        : null,
      classification: "",
      pc02_wave: "",
      pc02_action: "",
      resolver_status: null as string | null,
      resolver_product_id: null as string | null,
      execute_ready: false,
      next_prompt: "",
    };

    const classification = classifyRow(base);
    const wave = assignPc02Wave(classification, api404Ids, base.expected_package_id);

    let resolver_status: string | null = "skipped";
    let resolver_product_id: string | null = null;
    if (base.store_id) {
      const codes = [base.fnsku, base.asin, base.sku, base.upc].filter(Boolean) as string[];
      for (const code of codes) {
        const c = classifyProductBarcode(code);
        const res = await resolveScannerProductIdentifiers(sb, {
          organizationId: base.organization_id,
          storeId: base.store_id,
          sku: c.kind === "sku_msku" ? c.normalized : null,
          asin: c.kind === "asin" ? c.normalized : null,
          fnsku: c.kind === "fnsku" ? c.normalized : null,
          upc: c.kind === "upc_ean" ? c.normalized : null,
          productIdentifier: c.normalized,
        });
        if (res.identifier_resolution_status === "resolved" && res.resolved_product_id) {
          resolver_status = res.identifier_resolution_status;
          resolver_product_id = res.resolved_product_id;
          break;
        }
        if (res.identifier_resolution_status === "ambiguous") {
          resolver_status = res.identifier_resolution_status;
          break;
        }
        resolver_status = res.identifier_resolution_status;
      }
    }

    rows.push({
      ...base,
      classification,
      ...wave,
      resolver_status,
      resolver_product_id,
      execute_ready:
        wave.execute_ready &&
        classification === "e1b_map_bridge_candidate" &&
        !!base.trusted_single_product_id,
    });
  }

  const byWave = new Map<string, ReviewRow[]>();
  const byClass = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    const wl = byWave.get(row.pc02_wave) ?? [];
    wl.push(row);
    byWave.set(row.pc02_wave, wl);
    const cl = byClass.get(row.classification) ?? [];
    cl.push(row);
    byClass.set(row.classification, cl);
  }

  const executeReady = rows.filter((r) => r.execute_ready);
  const resolverDrift = rows.filter(
    (r) => r.resolver_status === "resolved" && r.resolver_product_id && r.read_bucket === "unresolved",
  );

  const matrix = {
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    mode: "read_only_wave",
    inputs: { pc01_manifest: PC01_MANIFEST, v202_manual_manifest: V202_MANUAL_MANIFEST },
    live_coverage: coverage,
    unresolved_count: rows.length,
    classification_counts: Object.fromEntries([...byClass].map(([k, v]) => [k, v.length])),
    pc02_wave_counts: Object.fromEntries([...byWave].map(([k, v]) => [k, v.length])),
    execute_ready_count: executeReady.length,
    resolver_drift_count: resolverDrift.length,
    rows,
  };

  fs.writeFileSync(path.join(outDir, "unresolved-cohort-matrix.json"), JSON.stringify(matrix, null, 2));

  const csvHeader = [
    "expected_package_id",
    "fnsku",
    "sku",
    "asin",
    "classification",
    "pc02_wave",
    "pc02_action",
    "resolver_status",
    "resolver_product_id",
    "execute_ready",
    "next_prompt",
  ];
  fs.writeFileSync(
    path.join(outDir, "sub-wave-queue.csv"),
    [
      csvHeader.join(","),
      ...rows.map((r) =>
        [
          r.expected_package_id,
          r.fnsku,
          r.sku,
          r.asin,
          r.classification,
          r.pc02_wave,
          r.pc02_action,
          r.resolver_status,
          r.resolver_product_id,
          r.execute_ready,
          r.next_prompt,
        ]
          .map(csvEscape)
          .join(","),
      ),
    ].join("\n") + "\n",
  );

  const waveSummary = [
    "# PC02 — Expected packages canonicalization wave",
    "",
    `**Run id:** \`${runId}\``,
    `**Branch:** \`${branch}\``,
    `**Staging ref:** \`${STAGING_REF}\``,
    `**Mode:** read-only (no DB writes)`,
    "",
    "## Live coverage",
    "",
    `| Metric | Count |`,
    `|--------|------:|`,
    `| Total expected_packages | ${coverage.total} |`,
    `| Read-layer resolved | ${coverage.read_layer_resolved} |`,
    `| Unresolved (this wave) | ${coverage.unresolved} |`,
    `| Ambiguous | ${coverage.ambiguous} |`,
    "",
    "## PC02 sub-waves",
    "",
    ...[...byWave.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([wave, list]) => `- **${wave}**: ${list.length} rows → \`${list[0]?.pc02_action}\``),
    "",
    `**Execute-ready (governed map-only):** ${executeReady.length}`,
    `**Resolver drift (resolved locally, EP still unresolved):** ${resolverDrift.length}`,
    "",
    "## Wave ordering",
    "",
    "1. **wave_d_map_bridge** — E1B map-only if candidates exist (separate approval)",
    "2. **wave_b_source_disagreement** — operator reconcile trusted imports",
    "3. **wave_a_dirty_source** — fix UNKNOW / ASIN-in-FNSKU before any map/API",
    "4. **wave_c_api_catalog_404** — manual PIM link after MP validation",
    "5. **wave_c_api_evidence** — gated SP-API only if not already 404",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "wave-summary.md"), `${waveSummary}\n`);

  fs.writeFileSync(
    path.join(outDir, "execute-readiness.md"),
    [
      "# Execute readiness",
      "",
      "| Cohort | Rows | Ready | Approval / blocker |",
      "|--------|-----:|------:|-------------------|",
      ...[...byWave.entries()].map(([wave, list]) => {
        const ready = list.filter((r) => r.execute_ready).length;
        const approval =
          wave === "wave_d_map_bridge"
            ? "E1B map-only operator approval required"
            : wave.startsWith("wave_c")
              ? "API/manual — no blind execute"
              : "Operator action first";
        return `| ${wave} | ${list.length} | ${ready} | ${approval} |`;
      }),
      "",
      "## Auto-execute in this prompt",
      "",
      executeReady.length
        ? `- **${executeReady.length}** map-bridge rows — run \`PC02B — EXPECTED-PACKAGES-E1B-MAP-BRIDGE-EXECUTE\` after approval`
        : "- **None** — all 49 rows require operator fix, reconcile, or separate governed execute.",
      "",
      "## Resolver drift",
      "",
      resolverDrift.length
        ? resolverDrift
            .slice(0, 10)
            .map(
              (r) =>
                `- \`${r.expected_package_id}\` → resolver ${r.resolver_product_id} (verify map exists; read-layer should pick up)`,
            )
            .join("\n")
        : "- None detected.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "next-prompts.md"),
    [
      "# Next prompts (ordered)",
      "",
      executeReady.length
        ? "1. **PC02B — EXPECTED-PACKAGES-E1B-MAP-BRIDGE-EXECUTE** — map-only for execute-ready cohort"
        : "1. ~~PC02B map-bridge~~ — skip (0 candidates)",
      "2. **PC03 — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE** — wave_b rows",
      "3. **PC03 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN** — wave_a_dirty_source rows",
      "4. **PC02C — EXPECTED-PACKAGES-API-404-MANUAL-QUEUE** — catalog 404 follow-up",
      "5. **PC04 — return_items canonicalization wave** (after expected_packages stable)",
    ].join("\n") + "\n",
  );

  const blockers = [
    "# Blockers",
    "",
    "- No DB writes in PC02 — wave plan only.",
    "- **38+ dirty source rows** block map-only and API until identifiers fixed.",
    "- **6 source disagreement** rows need operator canonical product pick.",
    "- **5 API catalog 404** — SP-API retry blocked; manual link required.",
    "- `expected_packages` is read-layer-only — do not bulk-update `resolved_product_id` on source rows.",
    coverage.unresolved !== 49 ? `- Coverage drift: expected 49 unresolved, live ${coverage.unresolved}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  fs.writeFileSync(path.join(outDir, "blockers.md"), `${blockers}\n`);

  const status =
    rows.length === 0 ? "PASS_EMPTY" : executeReady.length > 0 ? "READY_FOR_MAP_EXECUTE" : "PASS_MANUAL_QUEUE";

  const manifest = {
    prompt: "PC02 — EXPECTED-PACKAGES-CANONICALIZATION-WAVE",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status,
    live_coverage: coverage,
    unresolved_rows: rows.length,
    pc02_wave_counts: matrix.pc02_wave_counts,
    execute_ready_count: executeReady.length,
    next_prompt: executeReady.length
      ? "PC02B — EXPECTED-PACKAGES-E1B-MAP-BRIDGE-EXECUTE"
      : "PC03 — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE",
    forbidden: {
      db_writes: false,
      amazon_api: false,
      production: false,
      blind_bulk: false,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
