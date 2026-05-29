/**
 * PC07 — EXPECTED-PACKAGES DIRTY SOURCE QUARANTINE PLAN
 *
 * Read-only: recompute unresolved EP, classify every row, quarantine/triage plan.
 * No DB writes, no Amazon API, no product create, no map inserts.
 *
 *   npx tsx scripts/pc07-expected-packages-dirty-source-quarantine-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/pc07-expected-packages-dirty-source-quarantine-plan";
const PC01_RUN = "20260522T230000Z";
const PC03A_RUN = "20260523T040000Z";
const API_EXECUTE_DIR =
  ".cursor/audit-reports/expected-packages-amazon-api-evidence-execute-v202/20260522T210000Z";

const APPROVAL_DIRTY = ".cursor/operator-approvals/pc07-expected-packages-dirty-source-fix-execute-approval.md";
const APPROVAL_DISAGREE =
  ".cursor/operator-approvals/pc07-expected-packages-source-disagreement-map-execute-approval.md";
const APPROVAL_API404 = ".cursor/operator-approvals/pc07-sp-api-evidence-retry-execute-approval.md";

type Pc07Classification =
  | "dirty_identifier"
  | "source_disagreement"
  | "api_404_catalog_not_found"
  | "missing_identifier"
  | "ambiguous"
  | "manual_review";

type DirtyReason =
  | "asin_in_fnsku_field"
  | "unknow_sku"
  | "unknow_sku_with_x_fnsku"
  | "missing_store"
  | "test_placeholder";

type SourceHit = {
  source_table: string;
  source_row_id: string;
  product_id: string;
  asin: string | null;
  product_name: string | null;
  seller_sku: string | null;
  fnsku: string | null;
};

type ClassifiedRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  build_source: string | null;
  order_id: string | null;
  read_bucket: string;
  map_distinct_product_ids: string[];
  map_fnsku_product_count: number;
  map_sku_product_count: number;
  trusted_source_product_count: number;
  trusted_sample_product_name: string | null;
  trusted_sample_asin: string | null;
  trusted_single_product_id: string | null;
  pc07_classification: Pc07Classification;
  pc07_subreason: string;
  recommended_action: string;
  next_execute_prompt: string;
  dirty_reasons: DirtyReason[];
  quarantine_lane: string | null;
  source_hits: SourceHit[];
  recommended_authoritative_product_id: string | null;
  authoritative_rationale: string | null;
  api404_prior_outcome: string | null;
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

function isDirty(row: { sku: string | null; fnsku: string | null; store_id: string | null }): boolean {
  const sku = (row.sku ?? "").trim().toUpperCase();
  const fnsku = (row.fnsku ?? "").trim().toUpperCase();
  if (!row.store_id) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN|UNKNOW)$/i.test(sku)) return true;
  if (/^(TEST|DUMMY)$/i.test(fnsku)) return true;
  if (/^B[0-9A-Z]{9}$/.test(fnsku)) return true;
  return false;
}

function classifyDirtyReasons(row: {
  sku: string | null;
  fnsku: string | null;
  store_id: string | null;
}): DirtyReason[] {
  const reasons: DirtyReason[] = [];
  const sku = (row.sku ?? "").trim().toUpperCase();
  const fnsku = (row.fnsku ?? "").trim().toUpperCase();
  if (!row.store_id) reasons.push("missing_store");
  if (/^(TEST|DUMMY|PLACEHOLDER)$/i.test(sku) || /^(TEST|DUMMY)$/i.test(fnsku)) {
    reasons.push("test_placeholder");
  }
  if (/^(UNKNOWN|UNKNOW)$/i.test(sku)) reasons.push("unknow_sku");
  if (/^B[0-9A-Z]{9}$/.test(fnsku)) reasons.push("asin_in_fnsku_field");
  if (/^(UNKNOWN|UNKNOW)$/i.test(sku) && /^X[0-9A-Z]{9,}$/.test(fnsku)) {
    reasons.push("unknow_sku_with_x_fnsku");
  }
  return reasons;
}

function loadApi404EpIds(): Map<string, string> {
  const out = new Map<string, string>();
  const p = path.join(process.cwd(), API_EXECUTE_DIR, "execute-lines.json");
  if (!fs.existsSync(p)) return out;
  const lines = JSON.parse(fs.readFileSync(p, "utf8")) as Array<{
    expected_package_ids: string[];
    outcome: string;
  }>;
  for (const line of lines) {
    if (line.outcome === "catalog_lookup_failed") {
      for (const id of line.expected_package_ids) out.set(id, line.outcome);
    }
  }
  return out;
}

function scoreProductId(productId: string, hits: SourceHit[]): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const productHits = hits.filter((h) => h.product_id === productId);
  if (productHits.some((h) => h.source_table === "amazon_amazon_fulfilled_inventory")) {
    score += 30;
    reasons.push("amazon_amazon_fulfilled_inventory");
  }
  if (productHits.some((h) => h.source_table === "amazon_manage_fba_inventory")) {
    score += 20;
    reasons.push("amazon_manage_fba_inventory");
  }
  if (productHits.some((h) => h.source_table === "amazon_fba_inventory")) {
    score += 15;
    reasons.push("amazon_fba_inventory");
  }
  if (productHits.some((h) => h.product_name)) {
    score += 5;
    reasons.push("has_product_name");
  }
  return { score, reasons };
}

function pickAuthoritative(hits: SourceHit[]): { product_id: string | null; rationale: string } {
  const ids = [...new Set(hits.map((h) => h.product_id))];
  if (ids.length === 0) {
    return { product_id: null, rationale: "No expanded import source rows" };
  }
  if (ids.length === 1) {
    return {
      product_id: ids[0]!,
      rationale: "Single distinct product_id across inventory imports",
    };
  }
  const ranked = ids
    .map((id) => {
      const { score, reasons } = scoreProductId(id, hits);
      return { id, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
  const top = ranked[0]!;
  const second = ranked[1]!;
  if (top.score === second.score) {
    return {
      product_id: null,
      rationale: `Tie: ${top.id} vs ${second.id} — operator must pick authoritative source`,
    };
  }
  return {
    product_id: top.id,
    rationale: `Recommend ${top.id} (score ${top.score} vs ${second.score}): ${top.reasons.join(", ")}`,
  };
}

function classifyPc07(
  row: Omit<
    ClassifiedRow,
    | "pc07_classification"
    | "pc07_subreason"
    | "recommended_action"
    | "next_execute_prompt"
    | "dirty_reasons"
    | "quarantine_lane"
    | "source_hits"
    | "recommended_authoritative_product_id"
    | "authoritative_rationale"
    | "api404_prior_outcome"
  >,
  api404Map: Map<string, string>,
): Pick<
  ClassifiedRow,
  | "pc07_classification"
  | "pc07_subreason"
  | "recommended_action"
  | "next_execute_prompt"
  | "dirty_reasons"
  | "quarantine_lane"
  | "api404_prior_outcome"
> {
  const dirtyReasons = classifyDirtyReasons(row);
  const mapAmbiguous =
    row.map_distinct_product_ids.length > 1 ||
    row.map_fnsku_product_count > 1 ||
    row.map_sku_product_count > 1;
  const hasId = !!(row.sku || row.fnsku || row.asin || row.upc);
  const asin = row.asin ?? row.trusted_sample_asin;
  const api404 = api404Map.get(row.expected_package_id) ?? null;

  if (isDirty(row)) {
    const lane =
      dirtyReasons.includes("test_placeholder") || dirtyReasons.includes("missing_store")
        ? "quarantine_exclude_from_linkage_waves"
        : dirtyReasons.includes("asin_in_fnsku_field")
          ? "quarantine_pending_source_identifier_fix"
          : "operator_manual_identifier_fix";
    return {
      pc07_classification: "dirty_identifier",
      pc07_subreason: dirtyReasons.join("|") || "dirty",
      recommended_action: "quarantine_do_not_map_or_create_until_identifiers_fixed",
      next_execute_prompt: "PC07-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE",
      dirty_reasons: dirtyReasons,
      quarantine_lane: lane,
      api404_prior_outcome: null,
    };
  }
  if (!hasId) {
    return {
      pc07_classification: "missing_identifier",
      pc07_subreason: "no_sku_fnsku_asin_upc",
      recommended_action: "enrich_from_source_detail_or_manual_entry",
      next_execute_prompt: "PC07-MANUAL — EXPECTED-PACKAGES-MISSING-IDENTIFIER-QUEUE",
      dirty_reasons: [],
      quarantine_lane: "manual_enrichment_queue",
      api404_prior_outcome: null,
    };
  }
  if (mapAmbiguous) {
    return {
      pc07_classification: "ambiguous",
      pc07_subreason: `map_product_ids=${row.map_distinct_product_ids.join("|") || "multi_hit"}`,
      recommended_action: "manual_pick_product_or_merge_map_rows",
      next_execute_prompt: "PC07-MANUAL — EXPECTED-PACKAGES-MAP-AMBIGUOUS-QUEUE",
      dirty_reasons: [],
      quarantine_lane: "ambiguous_map_manual_queue",
      api404_prior_outcome: null,
    };
  }
  if (row.trusted_source_product_count > 1) {
    return {
      pc07_classification: "source_disagreement",
      pc07_subreason: `distinct_trusted_source_products=${row.trusted_source_product_count}`,
      recommended_action: "reconcile_imports_before_map_bridge",
      next_execute_prompt: "PC07-EXEC — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-MAP-EXECUTE",
      dirty_reasons: [],
      quarantine_lane: "source_disagreement_hold",
      api404_prior_outcome: null,
    };
  }
  if (api404 && asin && /^B[0-9A-Z]{9}$/i.test(asin.trim())) {
    return {
      pc07_classification: "api_404_catalog_not_found",
      pc07_subreason: `prior_outcome=${api404};asin=${asin}`,
      recommended_action: "sp_api_evidence_only_retry_or_manual_evidence_no_product_create",
      next_execute_prompt: "PC07-EXEC — SP-API-EVIDENCE-RETRY-MANUAL-QUEUE",
      dirty_reasons: [],
      quarantine_lane: "api_404_evidence_queue",
      api404_prior_outcome: api404,
    };
  }
  if (asin && /^B[0-9A-Z]{9}$/i.test(asin.trim()) && row.store_id) {
    return {
      pc07_classification: "manual_review",
      pc07_subreason: "api_evidence_candidate_not_prior_404",
      recommended_action: "governed_sp_api_evidence_dry_run_then_manual_if_needed",
      next_execute_prompt: "PC02-EXEC — SP-API-EVIDENCE-DRY-RUN (gated; no product create)",
      dirty_reasons: [],
      quarantine_lane: "sp_api_evidence_gate",
      api404_prior_outcome: null,
    };
  }
  if (row.trusted_sample_product_name && row.trusted_source_product_count === 0 && row.map_distinct_product_ids.length === 0) {
    return {
      pc07_classification: "manual_review",
      pc07_subreason: "e2_promotion_blocked_no_auto_create",
      recommended_action: "operator_pim_review_separate_e2_approval",
      next_execute_prompt: "EXPECTED-PACKAGES-E2-SUPPLEMENTAL-PROMOTION-PLAN (separate gate)",
      dirty_reasons: [],
      quarantine_lane: "e2_promotion_manual_gate",
      api404_prior_outcome: null,
    };
  }
  if (
    row.trusted_source_product_count === 1 &&
    row.trusted_single_product_id &&
    row.map_distinct_product_ids.length === 0
  ) {
    return {
      pc07_classification: "manual_review",
      pc07_subreason: "e1b_map_bridge_blocked_until_upstream_triage",
      recommended_action: "map_only_after_dirty_and_disagreement_cohorts_cleared",
      next_execute_prompt: "PC03A — EXPECTED-RETURN-SLIP-MAP-ONLY-EXECUTE-PLAN (re-run after PC07 executes)",
      dirty_reasons: [],
      quarantine_lane: "deferred_map_only",
      api404_prior_outcome: null,
    };
  }
  return {
    pc07_classification: "manual_review",
    pc07_subreason: "identifier_no_deterministic_path",
    recommended_action: "operator_pim_manual_link",
    next_execute_prompt: "PC07-MANUAL — EXPECTED-PACKAGES-IDENTIFIER-REVIEW-QUEUE",
    dirty_reasons: [],
    quarantine_lane: "identifier_manual_queue",
    api404_prior_outcome: null,
  };
}

async function expandSourceHits(
  client: pg.Client,
  row: Pick<ClassifiedRow, "organization_id" | "store_id" | "fnsku" | "sku">,
): Promise<SourceHit[]> {
  if (!row.store_id) return [];
  const r = await client.query(
    `
    SELECT source_table, source_row_id::text, product_id::text, asin, product_name, seller_sku, fnsku
    FROM (
      SELECT 'amazon_amazon_fulfilled_inventory'::text AS source_table, a.id AS source_row_id,
        COALESCE(a.resolved_product_id, a.product_id) AS product_id,
        NULLIF(TRIM(a.asin), '') AS asin, NULL::text AS product_name,
        NULLIF(TRIM(a.seller_sku), '') AS seller_sku,
        NULLIF(TRIM(a.fulfillment_channel_sku), '') AS fnsku
      FROM public.amazon_amazon_fulfilled_inventory a
      WHERE a.organization_id = $1::uuid AND a.store_id = $2::uuid
        AND COALESCE(a.resolved_product_id, a.product_id) IS NOT NULL
        AND (($3::text IS NOT NULL AND a.fulfillment_channel_sku = $3)
          OR ($4::text IS NOT NULL AND a.seller_sku = $4))
      UNION ALL
      SELECT 'amazon_fba_inventory', f.id,
        COALESCE(f.resolved_product_id, f.product_id),
        NULLIF(TRIM(f.asin), ''), NULLIF(TRIM(f.product_name), ''),
        NULLIF(TRIM(f.sku), ''), NULLIF(TRIM(f.fnsku), '')
      FROM public.amazon_fba_inventory f
      WHERE f.organization_id = $1::uuid AND f.store_id = $2::uuid
        AND COALESCE(f.resolved_product_id, f.product_id) IS NOT NULL
        AND (($3::text IS NOT NULL AND f.fnsku = $3) OR ($4::text IS NOT NULL AND f.sku = $4))
      UNION ALL
      SELECT 'amazon_manage_fba_inventory', mf.id,
        COALESCE(mf.resolved_product_id, mf.product_id),
        NULLIF(TRIM(mf.asin), ''), NULLIF(TRIM(mf.product_name), ''),
        NULLIF(TRIM(mf.sku), ''), NULLIF(TRIM(mf.fnsku), '')
      FROM public.amazon_manage_fba_inventory mf
      WHERE mf.organization_id = $1::uuid AND mf.store_id = $2::uuid
        AND COALESCE(mf.resolved_product_id, mf.product_id) IS NOT NULL
        AND (($3::text IS NOT NULL AND mf.fnsku = $3) OR ($4::text IS NOT NULL AND mf.sku = $4))
    ) s
    WHERE product_id IS NOT NULL
    ORDER BY source_table, product_id
    `,
    [row.organization_id, row.store_id, row.fnsku, row.sku],
  );
  return r.rows as SourceHit[];
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error("Staging guard failed");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!url || refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("Supabase guard failed");

  const api404Map = loadApi404EpIds();
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
  const hasOrderId = epCols.has("order_id");
  const asinExpr = hasAsinCol ? "NULLIF(TRIM(e.asin), '')" : "NULL::text";
  const upcExpr = epCols.has("upc")
    ? "NULLIF(TRIM(e.upc), '')"
    : epCols.has("upc_code")
      ? "NULLIF(TRIM(e.upc_code), '')"
      : "NULL::text";
  const orderExpr = hasOrderId ? "NULLIF(TRIM(e.order_id), '')" : "NULL::text";
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
        NULLIF(TRIM(e.build_source), '') AS build_source,
        ${orderExpr} AS order_id,
        e.resolved_product_id
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

  const rows: ClassifiedRow[] = [];
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
      order_id: r.order_id ? String(r.order_id) : null,
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
    };
    const cls = classifyPc07(base, api404Map);
    let sourceHits: SourceHit[] = [];
    let recommended_authoritative_product_id: string | null = null;
    let authoritative_rationale: string | null = null;
    if (cls.pc07_classification === "source_disagreement") {
      sourceHits = await expandSourceHits(client, base);
      const pick = pickAuthoritative(sourceHits);
      recommended_authoritative_product_id = pick.product_id;
      authoritative_rationale = pick.rationale;
    }
    rows.push({
      ...base,
      ...cls,
      source_hits: sourceHits,
      recommended_authoritative_product_id,
      authoritative_rationale,
    });
  }

  await client.end();

  const coverage = coverageRes.rows[0] as Record<string, number>;
  const countBy = (c: Pc07Classification) => rows.filter((r) => r.pc07_classification === c).length;
  const dirtyCount = countBy("dirty_identifier");
  const disagreeCount = countBy("source_disagreement");
  const api404Count = countBy("api_404_catalog_not_found");
  const manualCount = countBy("manual_review");

  const csvHeader = [
    "expected_package_id",
    "organization_id",
    "store_id",
    "sku",
    "fnsku",
    "asin",
    "upc",
    "build_source",
    "order_id",
    "pc07_classification",
    "pc07_subreason",
    "quarantine_lane",
    "recommended_action",
    "next_execute_prompt",
    "trusted_source_product_count",
    "map_distinct_product_ids",
    "recommended_authoritative_product_id",
    "authoritative_rationale",
    "api404_prior_outcome",
  ];
  const csvLines = [
    csvHeader.join(","),
    ...rows.map((r) =>
      csvHeader
        .map((h) => {
          const v = (r as unknown as Record<string, unknown>)[h];
          if (h === "map_distinct_product_ids" && Array.isArray(v)) return csvEscape(v.join("|"));
          return csvEscape(v);
        })
        .join(","),
    ),
  ];
  fs.writeFileSync(path.join(outDir, "unresolved-expected-packages-classification.csv"), `${csvLines.join("\n")}\n`);

  const dirtyRows = rows.filter((r) => r.pc07_classification === "dirty_identifier");
  const quarantinePlan = [
    "# Quarantine plan — dirty identifiers",
    "",
    "**Policy:** Quarantine is a triage lane only — no `expected_packages` UPDATE in this plan.",
    "",
    "## Summary",
    "",
    `- **Dirty identifier rows:** ${dirtyRows.length}`,
    `- **Total unresolved EP:** ${coverage.unresolved}`,
    "",
    "## Quarantine table (file plan)",
    "",
    "| expected_package_id | sku | fnsku | dirty_reasons | quarantine_lane | next step |",
    "|---------------------|-----|-------|---------------|-----------------|-----------|",
    ...dirtyRows.map(
      (r) =>
        `| \`${r.expected_package_id.slice(0, 8)}…\` | ${r.sku ?? ""} | ${r.fnsku ?? ""} | ${r.dirty_reasons.join(", ")} | ${r.quarantine_lane} | governed source fix after approval |`,
    ),
    "",
    "## Lanes",
    "",
    "| Lane | Meaning |",
    "|------|---------|",
    "| `quarantine_exclude_from_linkage_waves` | Test/placeholder/missing store — exclude from map/API waves |",
    "| `quarantine_pending_source_identifier_fix` | ASIN-in-FNSKU swap — fix identifiers from inventory spine proof |",
    "| `operator_manual_identifier_fix` | UNKNOW SKU / X-FNSKU patterns — operator confirms before any write |",
    "",
    "## Post-quarantine sequence",
    "",
    "1. **PC07-EXEC — DIRTY-SOURCE-FIX** — UPDATE `sku`/`fnsku` only (approval required)",
    "2. Re-run **PC03A** map-only plan — expect new deterministic candidates",
    "3. Separate map-only execute — never bulk `resolved_product_id` on EP",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "quarantine-plan.md"), `${quarantinePlan}\n`);

  const disagreeRows = rows.filter((r) => r.pc07_classification === "source_disagreement");
  const disagreeMd = [
    "# Source disagreement report",
    "",
    `**Rows:** ${disagreeRows.length}`,
    "",
    ...disagreeRows.map((r) => {
      const bySource = new Map<string, SourceHit[]>();
      for (const h of r.source_hits) {
        const list = bySource.get(h.source_table) ?? [];
        list.push(h);
        bySource.set(h.source_table, list);
      }
      const sourceLines = [...bySource.entries()]
        .map(([table, hits]) => {
          const pids = [...new Set(hits.map((h) => h.product_id))];
          return `- **${table}:** ${hits.length} hit(s) → product_ids: ${pids.join(", ")}`;
        })
        .join("\n");
      return [
        `## EP \`${r.expected_package_id}\``,
        "",
        `- **Identifiers:** sku=\`${r.sku ?? ""}\` fnsku=\`${r.fnsku ?? ""}\` asin=\`${r.asin ?? ""}\``,
        `- **Trusted distinct count:** ${r.trusted_source_product_count}`,
        "",
        "### Conflicting sources",
        sourceLines || "- *(no expanded hits — use trusted count)*",
        "",
        "### Recommended authoritative source",
        `- **Product:** ${r.recommended_authoritative_product_id ?? "*(operator pick required)*"}`,
        `- **Rationale:** ${r.authoritative_rationale ?? ""}`,
        "",
        "**Rule:** Map bridge only after operator confirms authoritative product — no product create.",
        "",
      ].join("\n");
    }),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "source-disagreement-report.md"), `${disagreeMd}\n`);

  const api404Rows = rows.filter((r) => r.pc07_classification === "api_404_catalog_not_found");
  const apiMd = [
    "# API 404 review queue",
    "",
    "**Policy:** SP-API evidence-only retry or manual evidence upload — **no product create**, no map insert until evidence resolves ASIN.",
    "",
    `**Prior execute reference:** \`${API_EXECUTE_DIR}\``,
    "",
    "| expected_package_id | asin | fnsku | sku | prior_outcome | recommended_action |",
    "|---------------------|------|-------|-----|---------------|-------------------|",
    ...api404Rows.map(
      (r) =>
        `| \`${r.expected_package_id}\` | ${r.asin ?? r.trusted_sample_asin ?? ""} | ${r.fnsku ?? ""} | ${r.sku ?? ""} | ${r.api404_prior_outcome ?? ""} | evidence retry / manual PIM link |`,
    ),
    "",
    api404Rows.length === 0 ? "*No rows in prior catalog_lookup_failed cohort among current unresolved.*" : "",
    "",
    "## Allowed next steps",
    "",
    "1. Governed SP-API catalog dry-run (read-only evidence capture)",
    "2. Operator manual evidence + PIM link if ASIN invalid for marketplace",
    "3. **Forbidden:** auto product promotion from title/OCR/fuzzy match",
  ]
    .filter(Boolean)
    .join("\n");
  fs.writeFileSync(path.join(outDir, "api-404-review-queue.md"), `${apiMd}\n`);

  const approvalDirty = `# PC07 expected_packages dirty source fix — execute approval

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| \`APPROVED_TO_RUN_STAGING\` | \`false\` |
| \`APPROVED_PC07_DIRTY_SOURCE_FIX\` | \`false\` |
| Plan | \`${OUT_BASE}/${runId}/quarantine-plan.md\` |
| Rows | ${dirtyCount} |

## Allowed write

UPDATE \`expected_packages.sku\` / \`expected_packages.fnsku\` for approved dirty rows only.

## Forbidden

product create; \`product_identifier_map\` insert; bulk \`resolved_product_id\`; production/original; Amazon API in same execute.

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_PC07_DIRTY_SOURCE_FIX=false
\`\`\`
`;
  fs.writeFileSync(path.join(process.cwd(), APPROVAL_DIRTY), approvalDirty);

  const approvalDisagree = `# PC07 expected_packages source disagreement map — execute approval

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| \`APPROVED_TO_RUN_STAGING\` | \`false\` |
| \`APPROVED_PC07_SOURCE_DISAGREEMENT_MAP\` | \`false\` |
| Plan | \`${OUT_BASE}/${runId}/source-disagreement-report.md\` |
| Rows | ${disagreeCount} |

## Allowed write

Governed \`product_identifier_map\` insert after operator confirms authoritative product per cluster.

## Forbidden

product create; UPDATE source inventory rows; production/original.

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_PC07_SOURCE_DISAGREEMENT_MAP=false
\`\`\`
`;
  fs.writeFileSync(path.join(process.cwd(), APPROVAL_DISAGREE), approvalDisagree);

  const approvalApi = `# PC07 SP-API evidence retry — execute approval

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| \`APPROVED_TO_RUN_STAGING\` | \`false\` |
| \`APPROVED_PC07_SP_API_EVIDENCE_RETRY\` | \`false\` |
| Plan | \`${OUT_BASE}/${runId}/api-404-review-queue.md\` |
| Rows | ${api404Count} |

## Allowed

SP-API catalog evidence capture (read-only audit artifacts); manual evidence queue updates.

## Forbidden

product create; \`product_identifier_map\` insert without separate map approval; fuzzy/title/OCR matching.

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_PC07_SP_API_EVIDENCE_RETRY=false
\`\`\`
`;
  fs.writeFileSync(path.join(process.cwd(), APPROVAL_API404), approvalApi);

  fs.writeFileSync(
    path.join(outDir, "approval-files.md"),
    [
      "# Approval files (default false)",
      "",
      "| File | Purpose | Rows | Default |",
      "|------|---------|-----:|---------|",
      `| \`${APPROVAL_DIRTY}\` | dirty source identifier UPDATE | ${dirtyCount} | false |`,
      `| \`${APPROVAL_DISAGREE}\` | source disagreement map bridge | ${disagreeCount} | false |`,
      `| \`${APPROVAL_API404}\` | SP-API evidence retry | ${api404Count} | false |`,
      "",
      "Map-only execute remains a **separate** approval after PC03A re-run post dirty-fix.",
    ].join("\n") + "\n",
  );

  const nextPrompt =
    dirtyCount > 0
      ? "PC07-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE"
      : disagreeCount > 0
        ? "PC07-EXEC — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-MAP-EXECUTE"
        : api404Count > 0
          ? "PC07-EXEC — SP-API-EVIDENCE-RETRY-MANUAL-QUEUE"
          : "PC03A — EXPECTED-RETURN-SLIP-MAP-ONLY-EXECUTE-PLAN (re-run)";

  fs.writeFileSync(
    path.join(outDir, "next-execute-prompts.md"),
    [
      "# Next execute prompts (ordered)",
      "",
      `**Recommended next:** \`${nextPrompt}\``,
      "",
      "1. **PC07-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE** — " +
        `${dirtyCount} rows; approval \`${APPROVAL_DIRTY}\``,
      "2. **PC03A — EXPECTED-RETURN-SLIP-MAP-ONLY-EXECUTE-PLAN** (re-run) — confirm post-fix map-only count",
      "3. **PC07-EXEC — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-MAP-EXECUTE** — " +
        `${disagreeCount} rows; approval \`${APPROVAL_DISAGREE}\``,
      "4. **PC07-EXEC — SP-API-EVIDENCE-RETRY-MANUAL-QUEUE** — " +
        `${api404Count} rows; approval \`${APPROVAL_API404}\``,
      "5. **PC07-MANUAL — EXPECTED-PACKAGES-IDENTIFIER-REVIEW-QUEUE** — " +
        `${manualCount} manual_review rows`,
      "",
      "**Wave order:** dirty fix → PC03A re-run → disagreement map → API 404 evidence → manual queues.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only plan — **no DB writes** in PC07.",
      `- **${coverage.unresolved}** unresolved expected_packages (PC01 baseline 49; PC03A recompute 43).`,
      `- **PC03A map-only candidates: 0** — gap is not map-only; upstream triage required.`,
      `- **${dirtyCount} dirty identifiers** block deterministic linkage.`,
      `- **${disagreeCount} source disagreement** rows need authoritative pick before map bridge.`,
      `- **${api404Count} API 404** rows — SP-API retry blocked without approval; no product create.`,
      `- **${manualCount} manual_review** — includes deferred e1b/e2 and identifier-only paths.`,
      "- expected_packages: read-layer-only for linkage; no bulk `resolved_product_id` persist.",
      "- No fuzzy/title/OCR matching in any execute path.",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "PC07 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    mode: "read_only",
    output_dir: `${OUT_BASE}/${runId}`,
    coverage,
    pc01_baseline_unresolved: 49,
    pc03a_recompute_unresolved: 43,
    unresolved_recomputed: coverage.unresolved,
    classification_counts: {
      dirty_identifier: dirtyCount,
      source_disagreement: disagreeCount,
      api_404_catalog_not_found: api404Count,
      missing_identifier: countBy("missing_identifier"),
      ambiguous: countBy("ambiguous"),
      manual_review: manualCount,
    },
    approval_files: [APPROVAL_DIRTY, APPROVAL_DISAGREE, APPROVAL_API404],
    recommended_next_prompt: nextPrompt,
    forbidden: {
      db_writes: true,
      product_create: true,
      map_insert: true,
      amazon_api: true,
      fuzzy_title_ocr: true,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
