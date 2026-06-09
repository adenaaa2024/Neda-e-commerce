/**
 * PHASE-5C-CLASS-C-GOVERNED-SEED-STAGING-SAMPLE (dry-run only)
 *   npx tsx scripts/phase5c-class-c-governed-seed-staging-sample.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  assertStagingSupabaseUrl,
  loadEnvLocalIntoProcess,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const BLOCKED_FNSKU = "X003UR3W83";
const OUT_BASE = ".cursor/audit-reports/phase5c-class-c-governed-seed-staging-sample";
const CATALOG_DELAY_MS = 200;

const CLASS_C_REVIEW = new Set([
  "bad_dirty_identifier",
  "should_not_auto_create",
  "bundle_kit_ambiguity",
  "missing_identifier",
]);

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function csvEsc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  fs.writeFileSync(
    filePath,
    [headers.join(","), ...rows.map((r) => headers.map((h) => csvEsc(r[h])).join(","))].join("\n") + "\n",
    "utf8",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isLikelyAsin(v: string | null | undefined): boolean {
  return /^B[0-9A-Z]{9}$/i.test(String(v ?? "").trim());
}

function identifierKey(row: { sku?: unknown; fnsku?: unknown; asin?: unknown }): string {
  return [String(row.sku ?? "").trim() || "(no-sku)", String(row.fnsku ?? "").trim() || "(no-fnsku)", String(row.asin ?? "").trim() || "(no-asin)"].join("|");
}

function catalogAsin(row: { sku?: unknown; fnsku?: unknown; asin?: unknown }): string | null {
  const asin = String(row.asin ?? "").trim().toUpperCase();
  if (isLikelyAsin(asin)) return asin;
  const fnsku = String(row.fnsku ?? "").trim().toUpperCase();
  if (isLikelyAsin(fnsku)) return fnsku;
  return null;
}

async function cols(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function buildClassifiedSql(epCols: Set<string>, mapCols: Set<string>, prodCols: Set<string>): string {
  const hasFnsku = epCols.has("fnsku");
  const hasSku = epCols.has("sku");
  const hasAsin = epCols.has("asin");
  const hasUpc = epCols.has("upc");
  const hasMapMsku = mapCols.has("msku");
  const missingCheck = [hasFnsku ? "b.has_fnsku" : null, hasSku ? "b.has_sku" : null, hasAsin ? "b.has_asin" : null, hasUpc ? "b.has_upc" : null]
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
    ${hasUpc ? "ep.upc" : "NULL::text AS upc"},
    ep.build_source, ep.carrier, ep.order_id, ep.source_detail_row_id,
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
  WHERE ep.organization_id = $1::uuid AND ep.resolved_product_id IS NULL
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
SELECT c.*,
  coalesce(cc.claim_count, 0)::int AS claim_candidate_count,
  coalesce(ri.return_item_count, 0)::int AS return_item_count
FROM classified c
LEFT JOIN (
  SELECT source_row_id, count(*)::int AS claim_count
  FROM claim_candidates
  WHERE organization_id = $1::uuid AND source_table = 'expected_packages' AND resolved_product_id IS NULL
  GROUP BY source_row_id
) cc ON cc.source_row_id = c.id
LEFT JOIN (
  SELECT expected_item_id, count(*)::int AS return_item_count
  FROM return_items
  WHERE organization_id = $1::uuid AND deleted_at IS NULL AND resolved_product_id IS NULL
  GROUP BY expected_item_id
) ri ON ri.expected_item_id = c.id
WHERE c.resolver_class = 'C'
ORDER BY coalesce(cc.claim_count,0) DESC, c.tracking_number NULLS LAST
`;
}

type ClassCRow = Record<string, unknown> & {
  id: string;
  review_class: string;
  resolver_class: string;
  claim_candidate_count: number;
  return_item_count: number;
};

function pickSampleRows(all: ClassCRow[]): ClassCRow[] {
  const picked = new Map<string, ClassCRow>();
  const take = (row: ClassCRow | undefined, reason: string) => {
    if (!row || picked.has(String(row.id))) return;
    const key = identifierKey(row);
    if ([...picked.values()].some((p) => identifierKey(p) === key && reason.includes("fill"))) return;
    picked.set(String(row.id), { ...row, sample_reason: reason } as ClassCRow);
  };

  const freq = new Map<string, number>();
  for (const r of all) {
    const k = identifierKey(r);
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const byFreq = [...all].sort((a, b) => (freq.get(identifierKey(b)) ?? 0) - (freq.get(identifierKey(a)) ?? 0));
  const byClaims = [...all].sort(
    (a, b) => Number(b.claim_candidate_count) - Number(a.claim_candidate_count) || Number(b.return_item_count) - Number(a.return_item_count),
  );

  const dirty = all.filter((r) => r.review_class === "bad_dirty_identifier");
  const noAuto = all.filter((r) => r.review_class === "should_not_auto_create");
  const blocked = all.filter((r) => String(r.fnsku ?? "").trim().toUpperCase() === BLOCKED_FNSKU);

  take(byFreq.find((r) => r.review_class === "bad_dirty_identifier"), "bad_dirty_high_frequency");
  take(byClaims.find((r) => r.review_class === "bad_dirty_identifier" && Number(r.claim_candidate_count) > 0), "bad_dirty_active_claims");
  take(dirty.find((r) => !picked.has(String(r.id))), "bad_dirty_representative");

  take(byFreq.find((r) => r.review_class === "should_not_auto_create"), "should_not_auto_create_high_frequency");
  take(byClaims.find((r) => r.review_class === "should_not_auto_create" && Number(r.claim_candidate_count) > 0), "should_not_auto_create_active_claims");
  take(noAuto.find((r) => !picked.has(String(r.id))), "should_not_auto_create_representative");

  take(blocked[0], "blocked_duplicate_fnsku_X003UR3W83");
  take(byClaims.find((r) => !picked.has(String(r.id)) && Number(r.claim_candidate_count) > 0), "scanner_claims_priority");
  take(byFreq.find((r) => !picked.has(String(r.id))), "high_frequency_fill");

  for (const r of [...byClaims, ...byFreq, ...all]) {
    if (picked.size >= 10) break;
    take(r, "representative_fill");
  }

  return [...picked.values()].slice(0, 10);
}

async function loadMapHits(client: pg.Client, row: ClassCRow, mapHasUpc: boolean): Promise<Record<string, unknown>[]> {
  const r = await client.query(
    `
    SELECT m.id::text AS map_id, m.product_id::text, m.asin, m.fnsku, m.seller_sku,
           ${mapHasUpc ? "m.upc_code" : "NULL::text AS upc_code"},
           p.product_name, p.asin AS product_asin
    FROM product_identifier_map m
    LEFT JOIN products p ON p.id = m.product_id AND p.deleted_at IS NULL
    WHERE m.deleted_at IS NULL AND m.organization_id = $1::uuid
      AND (m.store_id = $2::uuid OR m.store_id IS NULL)
      AND (
        (NULLIF(btrim($3::text), '') IS NOT NULL AND upper(btrim(m.fnsku)) = upper(btrim($3::text)))
        OR (NULLIF(btrim($4::text), '') IS NOT NULL AND upper(btrim(m.seller_sku)) = upper(btrim($4::text)))
        OR (NULLIF(btrim($5::text), '') IS NOT NULL AND upper(btrim(m.asin)) = upper(btrim($5::text)))
        OR (
          NULLIF(btrim($3::text), '') IS NOT NULL AND $3::text ~ '^B[0-9A-Z]{9}$'
          AND upper(btrim(m.asin)) = upper(btrim($3::text))
        )
      )
    ORDER BY m.updated_at DESC NULLS LAST
    LIMIT 20
    `,
    [ORG, STORE, row.fnsku ?? "", row.sku ?? "", row.asin ?? ""],
  );
  return r.rows as Record<string, unknown>[];
}

async function loadRemovalTitle(client: pg.Client, sourceDetailRowId: unknown): Promise<string | null> {
  if (!sourceDetailRowId) return null;
  const remCols = await cols(client, "amazon_removals");
  if (!remCols.size) return null;
  const titleCol = remCols.has("product_name") ? "product_name" : remCols.has("title") ? "title" : null;
  if (!titleCol) return null;
  const r = await client.query(`SELECT ${titleCol} AS title FROM amazon_removals WHERE id = $1::uuid LIMIT 1`, [
    sourceDetailRowId,
  ]);
  return (r.rows[0] as { title?: string } | undefined)?.title ?? null;
}

function suggestAction(args: {
  row: ClassCRow;
  mapHits: Record<string, unknown>[];
  catalogTitle: string | null;
  catalogAsin: string | null;
  identifierFreq: number;
}): { action: string; confidence: number; deterministic: boolean; reason: string } {
  const fnsku = String(args.row.fnsku ?? "").trim().toUpperCase();
  const mapProductIds = new Set(args.mapHits.map((h) => String(h.product_id ?? "")).filter(Boolean));
  const review = String(args.row.review_class);

  if (fnsku === BLOCKED_FNSKU || mapProductIds.size > 1) {
    return {
      action: "manual_review_blocked_duplicate",
      confidence: 0.1,
      deterministic: false,
      reason: fnsku === BLOCKED_FNSKU ? "blocked_fnsku_X003UR3W83" : "multiple_map_products",
    };
  }
  if (review === "bad_dirty_identifier") {
    if (args.catalogAsin && mapProductIds.size === 1) {
      return {
        action: "enrich_then_map_to_existing_product",
        confidence: 0.72,
        deterministic: true,
        reason: "catalog_asin_confirms_sole_map_after_identifier_cleanup",
      };
    }
    return {
      action: "enrich_identifiers_manual_review",
      confidence: 0.25,
      deterministic: false,
      reason: "dirty_sku_or_placeholder_fnsku_requires_operator_enrichment",
    };
  }
  if (mapProductIds.size === 1) {
    return {
      action: "map_to_existing_product_operator_confirm",
      confidence: 0.78,
      deterministic: true,
      reason: "sole_product_identifier_map_hit",
    };
  }
  if (Number(args.row.product_count) === 1 && args.row.sample_product_id) {
    return {
      action: "map_bridge_then_set_resolved",
      confidence: 0.68,
      deterministic: true,
      reason: "sole_product_direct_match_needs_map_bridge",
    };
  }
  if (args.catalogTitle && args.catalogAsin) {
    return {
      action: "governed_product_seed_with_catalog_evidence",
      confidence: 0.45,
      deterministic: false,
      reason: "valid_identifiers_no_spine_match_catalog_available_seed_requires_approval",
    };
  }
  if (args.identifierFreq >= 5) {
    return {
      action: "batch_manual_review_high_frequency",
      confidence: 0.3,
      deterministic: false,
      reason: `identifier_key_frequency_${args.identifierFreq}`,
    };
  }
  return {
    action: "manual_review_no_spine_match",
    confidence: 0.2,
    deterministic: false,
    reason: review,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL guard failed");
  if (stagingUrl.includes(ORIGINAL_REF)) throw new Error("BLOCKED: original postgres URL");

  const stagingSupabase =
    process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  if (stagingSupabase) process.env.NEXT_PUBLIC_SUPABASE_URL = stagingSupabase;
  assertStagingSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", "NEXT_PUBLIC_SUPABASE_URL");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const epCols = await cols(client, "expected_packages");
  const mapCols = await cols(client, "product_identifier_map");
  const prodCols = await cols(client, "products");

  const classifiedSql = buildClassifiedSql(epCols, mapCols, prodCols);
  const classC = await client.query(classifiedSql, [ORG]);
  const allRows = classC.rows as ClassCRow[];

  const reviewBreakdown: Record<string, number> = {};
  for (const r of allRows) {
    reviewBreakdown[String(r.review_class)] = (reviewBreakdown[String(r.review_class)] ?? 0) + 1;
  }

  const freq = new Map<string, number>();
  for (const r of allRows) {
    const k = identifierKey(r);
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }

  const sampleRows = pickSampleRows(allRows);

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require.cache[require.resolve("server-only")] = {
    id: "server-only",
    filename: "server-only",
    loaded: true,
    exports: {},
  } as NodeModule;
  const catalog = await import("../lib/pim-amazon-catalog-enrichment");
  const ctx = await catalog.resolveAmazonCatalogContext(ORG, STORE);
  let catalogToken: string | null = null;
  if (ctx.ok) {
    const tok = await catalog.getAmazonCatalogAccessToken({ credentials: ctx.credentials });
    if (tok.ok) catalogToken = tok.accessToken;
  }

  const evidenceSources = new Set<string>([
    "staging.expected_packages",
    "staging.product_identifier_map",
    "staging.products",
    "staging.amazon_removals",
    "staging.claim_candidates",
    "staging.return_items",
  ]);
  if (catalogToken) evidenceSources.add("amazon_catalog_items_api");

  const evidenceRows: Record<string, unknown>[] = [];

  for (let i = 0; i < sampleRows.length; i++) {
    const row = sampleRows[i]!;
    const mapHits = await loadMapHits(client, row, mapCols.has("upc_code"));
    const removalTitle = await loadRemovalTitle(client, row.source_detail_row_id);
    const idFreq = freq.get(identifierKey(row)) ?? 1;

    let catalogTitle: string | null = null;
    let catalogAsinUsed: string | null = null;
    let catalogStatus = "skipped_no_asin";
    const asinForCatalog = catalogAsin(row);

    if (catalogToken && ctx.ok && asinForCatalog) {
      const cat = await catalog.fetchAmazonCatalogItemJson({
        catalogHost: ctx.catalogHost,
        accessToken: catalogToken,
        marketplaceIds: ctx.marketplaceIds,
        asin: asinForCatalog,
      });
      if (cat.ok && cat.body && typeof cat.body === "object") {
        const summaries = (cat.body as Record<string, unknown>).summaries;
        if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
          catalogTitle = String((summaries[0] as Record<string, unknown>).itemName ?? "") || null;
        }
        catalogAsinUsed = asinForCatalog;
        catalogStatus = catalogTitle ? "ok" : "empty_title";
      } else {
        catalogStatus = cat.ok ? "empty_body" : `error_${cat.status ?? "unknown"}`;
      }
      if (i + 1 < sampleRows.length) await sleep(CATALOG_DELAY_MS);
    } else if (!asinForCatalog) {
      catalogStatus = "skipped_no_catalog_asin";
    } else {
      catalogStatus = "skipped_catalog_auth";
    }

    const suggestion = suggestAction({
      row,
      mapHits,
      catalogTitle,
      catalogAsin: catalogAsinUsed,
      identifierFreq: idFreq,
    });

    evidenceRows.push({
      expected_package_id: row.id,
      sample_reason: (row as { sample_reason?: string }).sample_reason ?? "",
      tracking_number: row.tracking_number,
      review_class: row.review_class,
      resolver_class: row.resolver_class,
      raw_identifier_key: identifierKey(row),
      identifier_frequency: idFreq,
      sku: row.sku,
      fnsku: row.fnsku,
      upc: row.upc ?? "",
      asin: row.asin,
      removal_title: removalTitle ?? "",
      display_title: catalogTitle ?? removalTitle ?? "",
      claim_candidate_count: row.claim_candidate_count,
      return_item_count: row.return_item_count,
      map_hit_count: mapHits.length,
      map_product_ids: [...new Set(mapHits.map((h) => h.product_id).filter(Boolean))].join(";"),
      map_hit_summary: mapHits
        .slice(0, 3)
        .map((h) => `${h.product_id}:${h.asin ?? ""}:${h.fnsku ?? ""}:${h.seller_sku ?? ""}`)
        .join(" | "),
      product_count: row.product_count,
      sample_product_id: row.sample_product_id ?? "",
      catalog_asin_queried: catalogAsinUsed ?? "",
      catalog_status: catalogStatus,
      catalog_title: catalogTitle ?? "",
      confidence: suggestion.confidence,
      deterministic_after_evidence: suggestion.deterministic ? "yes" : "no",
      suggested_action: suggestion.action,
      suggestion_reason: suggestion.reason,
      operator_decision: "",
      approved_by: "",
      persist_allowed: "no_dry_run",
    });
  }

  const riUnresolved = await client.query(
    `SELECT count(*)::int AS n FROM return_items WHERE organization_id=$1::uuid AND deleted_at IS NULL AND resolved_product_id IS NULL`,
    [ORG],
  );

  await client.end();

  const headers = [
    "expected_package_id",
    "sample_reason",
    "tracking_number",
    "review_class",
    "resolver_class",
    "raw_identifier_key",
    "identifier_frequency",
    "sku",
    "fnsku",
    "upc",
    "asin",
    "removal_title",
    "display_title",
    "claim_candidate_count",
    "return_item_count",
    "map_hit_count",
    "map_product_ids",
    "map_hit_summary",
    "product_count",
    "sample_product_id",
    "catalog_asin_queried",
    "catalog_status",
    "catalog_title",
    "confidence",
    "deterministic_after_evidence",
    "suggested_action",
    "suggestion_reason",
    "operator_decision",
    "approved_by",
    "persist_allowed",
  ];
  const csvPath = path.join(outDir, "manual_review_class_c_sample.csv");
  writeCsv(csvPath, headers, evidenceRows);

  const safeToPersist = evidenceRows.filter(
    (r) =>
      r.deterministic_after_evidence === "yes" &&
      Number(r.confidence) >= 0.7 &&
      !String(r.suggested_action).includes("seed") &&
      !String(r.suggested_action).includes("blocked"),
  ).length;
  const manualReview = evidenceRows.filter((r) => r.deterministic_after_evidence !== "yes").length;

  const duplicateBlockers: string[] = [
    `${BLOCKED_FNSKU} — duplicate FNSKU cluster on product_identifier_map; defer auto-map`,
  ];
  for (const r of evidenceRows) {
    if (String(r.fnsku ?? "").toUpperCase() === BLOCKED_FNSKU) {
      duplicateBlockers.push(`EP ${r.expected_package_id} uses blocked FNSKU ${BLOCKED_FNSKU}`);
    }
    if (Number(r.map_hit_count) > 1 && String(r.map_product_ids).includes(";")) {
      duplicateBlockers.push(`EP ${r.expected_package_id} — ${r.map_hit_count} map products for ${r.raw_identifier_key}`);
    }
  }

  const blockers = [
    `${allRows.length} Class C unresolved EP rows on staging — sample only, no persist`,
    "Do not overwrite resolved_product_id in this phase",
    "Do not auto-map ambiguous identifiers",
    "Product seed requires separate APPROVED_TO_SEED_CLASS_C operator approval",
    `${Number(riUnresolved.rows[0]?.n ?? 0)} return_items still unresolved`,
  ];
  if (safeToPersist === 0) blockers.push("No sample row reached deterministic safe-to-persist threshold in dry-run");
  if (reviewBreakdown.bad_dirty_identifier) {
    blockers.push(`${reviewBreakdown.bad_dirty_identifier} bad_dirty_identifier rows need enrichment before map`);
  }

  const nextExecutePrompt = `# PHASE-5C-CLASS-C-GOVERNED-SEED-STAGING-APPLY-SAMPLE

Mode: staging · approval-gated · max 10 approved rows · no production

Precondition:
- Operator completes \`manual_review_class_c_sample.csv\`
- Rows with deterministic_after_evidence=yes AND operator_decision=approve_map only
- APPROVED_CLASS_C_STAGING_SAMPLE=true in operator approval file

Allowed:
- UPDATE expected_packages.resolved_product_id for approved deterministic rows only
- INSERT product_identifier_map bridge when suggested_action=map_bridge_then_set_resolved

Forbidden:
- Overwrite existing resolved_product_id
- Auto-map blocked/ambiguous rows (incl. ${BLOCKED_FNSKU})
- Product CREATE without separate seed approval
- Production apply

Verify:
- unresolved EP decreases only by approved count
- claim_candidates inherit when EP source resolves
- npm run build + scanner smoke

Artifacts: .cursor/audit-reports/phase5c-class-c-governed-seed-staging-apply/<run_id>/
`;

  fs.writeFileSync(path.join(outDir, "next-execute-prompt.md"), nextExecutePrompt);

  const result = {
    phase_number: "5C",
    mode: "staging_dry_run_sample",
    staging_ref: STAGING_REF,
    class_c_unresolved_total: allRows.length,
    class_c_review_breakdown: reviewBreakdown,
    return_items_unresolved: Number(riUnresolved.rows[0]?.n ?? 0),
    sample_rows: evidenceRows.length,
    sample_row_ids: evidenceRows.map((r) => r.expected_package_id),
    evidence_sources: [...evidenceSources],
    safe_to_persist_count: safeToPersist,
    manual_review_count: manualReview,
    deterministic_after_evidence_count: evidenceRows.filter((r) => r.deterministic_after_evidence === "yes").length,
    duplicate_blockers: duplicateBlockers,
    SAFE_TO_EXECUTE_CLASS_C_STAGING_APPLY: safeToPersist > 0 ? "conditional" : "no",
    SAFE_TO_EXECUTE_CLASS_C_PRODUCTION: "no",
    blockers,
    manual_review_csv: csvPath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    next_execute_prompt: "PHASE-5C-CLASS-C-GOVERNED-SEED-STAGING-APPLY-SAMPLE",
  };

  fs.writeFileSync(path.join(outDir, "sample-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "sample-report.md"),
    [
      "# Phase 5C — Class C governed seed staging sample (dry-run)",
      "",
      `Run: \`${rid}\` · Staging: \`${STAGING_REF}\` · **No writes**`,
      "",
      "## Census",
      "",
      `- Class C unresolved EP: **${allRows.length}**`,
      `- bad_dirty_identifier: **${reviewBreakdown.bad_dirty_identifier ?? 0}**`,
      `- should_not_auto_create: **${reviewBreakdown.should_not_auto_create ?? 0}**`,
      `- return_items unresolved: **${result.return_items_unresolved}**`,
      "",
      "## Sample",
      "",
      `- Rows sampled: **${evidenceRows.length}**`,
      `- Safe to persist (deterministic, dry-run): **${safeToPersist}**`,
      `- Manual review in sample: **${manualReview}**`,
      "",
      `CSV: \`manual_review_class_c_sample.csv\``,
      "",
      `SAFE_TO_EXECUTE_CLASS_C_STAGING_APPLY: **${result.SAFE_TO_EXECUTE_CLASS_C_STAGING_APPLY}**`,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: rid,
        mode: "staging_dry_run_sample",
        artifacts: ["sample-result.json", "manual_review_class_c_sample.csv", "sample-report.md", "next-execute-prompt.md"],
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
