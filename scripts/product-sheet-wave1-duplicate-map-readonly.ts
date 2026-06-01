/**
 * PRODUCT-SHEET-WAVE1-DUPLICATE-MAP-READONLY
 * Classify pre-existing duplicate product_identifier_map rows blocking wave1/wave2 gate.
 *
 *   npx tsx scripts/product-sheet-wave1-duplicate-map-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MATCH_SOURCE = "product_sheet_wave1_sample";
const OUT_BASE = ".cursor/audit-reports/product-sheet-wave1-duplicate-map-readonly";

type MapRow = {
  id: string;
  product_id: string;
  organization_id: string;
  store_id: string;
  seller_sku: string | null;
  fnsku: string | null;
  asin: string | null;
  external_listing_id: string | null;
  match_source: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  product_sku: string | null;
  product_asin: string | null;
  item_name: string | null;
};

type GroupClassification =
  | "true_duplicate_same_product"
  | "conflicting_duplicate_different_product"
  | "stale_inactive_duplicate"
  | "scope_store_org_mismatch"
  | "mixed";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function classifyGroup(rows: MapRow[]): {
  classification: GroupClassification;
  detail: string;
  dedupe_safe: boolean;
  keep_id: string | null;
  soft_delete_ids: string[];
} {
  const active = rows.filter((r) => !r.deleted_at);
  const inactive = rows.filter((r) => r.deleted_at);

  const orgMismatch = rows.some((r) => r.organization_id !== ORG);
  const storeMismatch = rows.some((r) => r.store_id !== STORE);
  if (orgMismatch || storeMismatch) {
    return {
      classification: "scope_store_org_mismatch",
      detail: orgMismatch ? "organization_id differs from wave org" : "store_id differs from wave store",
      dedupe_safe: false,
      keep_id: null,
      soft_delete_ids: [],
    };
  }

  const productIds = [...new Set(active.map((r) => r.product_id))];
  if (productIds.length > 1) {
    return {
      classification: "conflicting_duplicate_different_product",
      detail: `${productIds.length} distinct product_id values among ${active.length} active rows`,
      dedupe_safe: false,
      keep_id: null,
      soft_delete_ids: [],
    };
  }

  if (active.length <= 1 && inactive.length > 0) {
    return {
      classification: "stale_inactive_duplicate",
      detail: `${inactive.length} soft-deleted row(s); ${active.length} active — gate counts deleted rows`,
      dedupe_safe: active.length === 1,
      keep_id: active[0]?.id ?? null,
      soft_delete_ids: inactive.map((r) => r.id),
    };
  }

  if (active.length > 1 && productIds.length === 1) {
    const sorted = [...active].sort((a, b) => {
      const ta = a.created_at ?? "";
      const tb = b.created_at ?? "";
      return ta.localeCompare(tb);
    });
    const keep = sorted[sorted.length - 1]!;
    const extras = sorted.slice(0, -1);
    return {
      classification: "true_duplicate_same_product",
      detail: `${active.length} active rows share product_id ${productIds[0]}; keep newest`,
      dedupe_safe: true,
      keep_id: keep.id,
      soft_delete_ids: extras.map((r) => r.id),
    };
  }

  if (active.length === 0 && inactive.length > 1) {
    return {
      classification: "stale_inactive_duplicate",
      detail: `All ${inactive.length} rows soft-deleted — verification gate still counts them`,
      dedupe_safe: false,
      keep_id: null,
      soft_delete_ids: [],
    };
  }

  return {
    classification: "mixed",
    detail: `active=${active.length} inactive=${inactive.length}`,
    dedupe_safe: false,
    keep_id: null,
    soft_delete_ids: [],
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  if (!supabaseUrlMatchesStagingRef(STAGING_REF)) {
    throw new Error(`Supabase URL must match staging ref ${STAGING_REF}`);
  }
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Exact gate query from product-sheet-staging-apply-wave1-sample.ts (no deleted_at filter)
  const gateDupes = await client.query<{ external_listing_id: string; c: number }>(
    `
    SELECT external_listing_id, COUNT(*)::int AS c
    FROM public.product_identifier_map
    WHERE match_source = $1
      AND external_listing_id IS NOT NULL
    GROUP BY external_listing_id
    HAVING COUNT(*) > 1
    ORDER BY c DESC, external_listing_id
    `,
    [MATCH_SOURCE],
  );

  const gateListingIds = gateDupes.rows.map((r) => r.external_listing_id);

  const detailRows = gateListingIds.length
    ? await client.query<MapRow>(
        `
        SELECT
          m.id::text,
          m.product_id::text,
          m.organization_id::text,
          m.store_id::text,
          m.seller_sku,
          m.fnsku,
          m.asin,
          m.external_listing_id,
          m.match_source,
          m.deleted_at::text,
          m.created_at::text,
          m.updated_at::text,
          p.sku AS product_sku,
          p.asin AS product_asin,
          p.product_name AS item_name
        FROM public.product_identifier_map m
        LEFT JOIN public.products p ON p.id = m.product_id
        WHERE m.match_source = $1
          AND m.external_listing_id = ANY($2::text[])
        ORDER BY m.external_listing_id, m.deleted_at NULLS FIRST, m.created_at
        `,
        [MATCH_SOURCE, gateListingIds],
      )
    : { rows: [] as MapRow[] };

  const byListing = new Map<string, MapRow[]>();
  for (const row of detailRows.rows) {
    const key = row.external_listing_id ?? "";
    if (!byListing.has(key)) byListing.set(key, []);
    byListing.get(key)!.push(row);
  }

  const duplicateGroups = gateDupes.rows.map((g) => {
    const rows = byListing.get(g.external_listing_id) ?? [];
    const cls = classifyGroup(rows);
    return {
      external_listing_id: g.external_listing_id,
      row_count: g.c,
      seller_skus: [...new Set(rows.map((r) => r.seller_sku).filter(Boolean))],
      product_ids: [...new Set(rows.map((r) => r.product_id))],
      active_count: rows.filter((r) => !r.deleted_at).length,
      inactive_count: rows.filter((r) => r.deleted_at).length,
      classification: cls.classification,
      detail: cls.detail,
      dedupe_safe: cls.dedupe_safe,
      keep_id: cls.keep_id,
      soft_delete_ids: cls.soft_delete_ids,
      rows,
    };
  });

  // Broader seller_sku duplicate census (active only, same org/store) — wave2 collision risk
  const skuDupes = await client.query<{ seller_sku: string; c: number; product_count: number }>(
    `
    SELECT
      seller_sku,
      COUNT(*)::int AS c,
      COUNT(DISTINCT product_id)::int AS product_count
    FROM public.product_identifier_map
    WHERE deleted_at IS NULL
      AND organization_id = $1::uuid
      AND store_id = $2::uuid
      AND seller_sku IS NOT NULL
      AND btrim(seller_sku) <> ''
    GROUP BY seller_sku
    HAVING COUNT(*) > 1
    ORDER BY product_count DESC, c DESC
    LIMIT 50
    `,
    [ORG, STORE],
  );

  const sampleSkuDupesInWave = await client.query(
    `
    WITH wave_skus AS (
      SELECT DISTINCT seller_sku
      FROM public.product_identifier_map
      WHERE match_source = $1
        AND seller_sku IS NOT NULL
    )
    SELECT d.seller_sku, d.c, d.product_count
    FROM (
      SELECT seller_sku, COUNT(*)::int AS c, COUNT(DISTINCT product_id)::int AS product_count
      FROM public.product_identifier_map
      WHERE deleted_at IS NULL AND organization_id = $2::uuid AND store_id = $3::uuid
        AND seller_sku IN (SELECT seller_sku FROM wave_skus)
      GROUP BY seller_sku
      HAVING COUNT(*) > 1
    ) d
    ORDER BY d.product_count DESC
    `,
    [MATCH_SOURCE, ORG, STORE],
  );

  const wave1Totals = await client.query(
    `
    SELECT
      COUNT(*)::int AS total_wave1_rows,
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active_wave1_rows,
      COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS inactive_wave1_rows,
      COUNT(DISTINCT external_listing_id) FILTER (WHERE external_listing_id IS NOT NULL)::int AS distinct_listing_ids,
      COUNT(*) FILTER (WHERE external_listing_id IS NULL)::int AS null_listing_id_rows,
      COUNT(*) FILTER (WHERE external_listing_id IS NOT NULL)::int AS non_null_listing_id_rows
    FROM public.product_identifier_map
    WHERE match_source = $1
    `,
    [MATCH_SOURCE],
  );

  const listingNullBreakdown = await client.query(
    `
    SELECT
      external_listing_id IS NULL AS listing_null,
      COUNT(*)::int AS row_count,
      COUNT(DISTINCT product_id)::int AS product_count,
      COUNT(DISTINCT seller_sku)::int AS sku_count
    FROM public.product_identifier_map
    WHERE match_source = $1
    GROUP BY 1
    ORDER BY 1
    `,
    [MATCH_SOURCE],
  );

  const sharedListingIdRows = await client.query<MapRow>(
    `
    SELECT
      m.id::text,
      m.product_id::text,
      m.organization_id::text,
      m.store_id::text,
      m.seller_sku,
      m.fnsku,
      m.asin,
      m.external_listing_id,
      m.match_source,
      m.deleted_at::text,
      m.created_at::text,
      m.updated_at::text,
      p.sku AS product_sku,
      p.asin AS product_asin,
      p.product_name AS item_name
    FROM public.product_identifier_map m
    LEFT JOIN public.products p ON p.id = m.product_id
    WHERE m.match_source = $1
      AND m.external_listing_id IS NOT NULL
    ORDER BY m.external_listing_id, m.seller_sku, m.created_at
    `,
    [MATCH_SOURCE],
  );

  const wave1SkuDupesWithinSource = await client.query(
    `
    SELECT seller_sku, COUNT(*)::int AS c, COUNT(DISTINCT product_id)::int AS product_count,
      array_agg(DISTINCT external_listing_id::text) AS listing_ids
    FROM public.product_identifier_map
    WHERE match_source = $1 AND deleted_at IS NULL
    GROUP BY seller_sku
    HAVING COUNT(*) > 1
    ORDER BY product_count DESC, c DESC
    `,
    [MATCH_SOURCE],
  );

  const crossSourceSkuDupes = await client.query(
    `
    WITH wave_skus AS (
      SELECT DISTINCT seller_sku
      FROM public.product_identifier_map
      WHERE match_source = $1 AND seller_sku IS NOT NULL AND deleted_at IS NULL
    )
    SELECT
      m.seller_sku,
      COUNT(*)::int AS map_row_count,
      COUNT(DISTINCT m.product_id)::int AS product_count,
      COUNT(DISTINCT m.match_source)::int AS match_source_count,
      array_agg(DISTINCT m.match_source ORDER BY m.match_source) AS match_sources,
      array_agg(m.id::text ORDER BY m.created_at) AS map_ids
    FROM public.product_identifier_map m
    JOIN wave_skus w ON w.seller_sku = m.seller_sku
    WHERE m.deleted_at IS NULL
      AND m.organization_id = $2::uuid
      AND m.store_id = $3::uuid
    GROUP BY m.seller_sku
    HAVING COUNT(*) > 1
    ORDER BY product_count DESC, map_row_count DESC
    `,
    [MATCH_SOURCE, ORG, STORE],
  );

  // Classify cross-source duplicates for wave sample SKUs
  type CrossSourceGroup = {
    seller_sku: string;
    map_row_count: number;
    product_count: number;
    match_source_count: number;
    match_sources: string[];
    map_ids: string[];
    classification: GroupClassification;
    detail: string;
    dedupe_safe: boolean;
  };

  const crossSourceClassified: CrossSourceGroup[] = [];
  for (const row of crossSourceSkuDupes.rows as CrossSourceGroup[]) {
    const detailRes = await client.query<MapRow>(
      `
      SELECT
        m.id::text, m.product_id::text, m.organization_id::text, m.store_id::text,
        m.seller_sku, m.fnsku, m.asin, m.external_listing_id, m.match_source,
        m.deleted_at::text, m.created_at::text, m.updated_at::text,
        p.sku AS product_sku, p.asin AS product_asin, p.product_name AS item_name
      FROM public.product_identifier_map m
      LEFT JOIN public.products p ON p.id = m.product_id
      WHERE m.id = ANY($1::uuid[])
      ORDER BY m.created_at
      `,
      [row.map_ids],
    );
    const cls = classifyGroup(detailRes.rows);
    crossSourceClassified.push({
      ...row,
      classification: cls.classification,
      detail: cls.detail,
      dedupe_safe: cls.dedupe_safe && row.product_count === 1,
    });
  }

  const nullListingIdWaveRows = await client.query<MapRow>(
    `
    SELECT
      m.id::text, m.product_id::text, m.organization_id::text, m.store_id::text,
      m.seller_sku, m.fnsku, m.asin, m.external_listing_id, m.match_source,
      m.deleted_at::text, m.created_at::text, m.updated_at::text,
      p.sku AS product_sku, p.asin AS product_asin, p.product_name AS item_name
    FROM public.product_identifier_map m
    LEFT JOIN public.products p ON p.id = m.product_id
    WHERE m.match_source = $1
      AND m.external_listing_id IS NULL
    ORDER BY m.seller_sku
    LIMIT 50
    `,
    [MATCH_SOURCE],
  );

  const nullListingGateTrap =
    Number(wave1Totals.rows[0]?.null_listing_id_rows ?? 0) > 1
      ? {
          would_fail_without_is_not_null_filter: true,
          explanation:
            "PostgreSQL GROUP BY external_listing_id collapses NULL into one bucket; pre-fix gate counted N NULL rows as one duplicate group",
          null_row_count: Number(wave1Totals.rows[0]?.null_listing_id_rows ?? 0),
          distinct_products: nullListingIdWaveRows.rows.length
            ? [...new Set(nullListingIdWaveRows.rows.map((r) => r.product_id))].length
            : 0,
          distinct_skus: nullListingIdWaveRows.rows.length
            ? [...new Set(nullListingIdWaveRows.rows.map((r) => r.seller_sku))].length
            : 0,
          classification: "false_positive_gate_null_listing_id_bucket",
          dedupe_safe: false,
          action: "No dedupe — re-run wave1 verification with current script (external_listing_id IS NOT NULL filter)",
        }
      : { would_fail_without_is_not_null_filter: false };

  await client.end();

  const safeDuplicates = duplicateGroups.filter((g) => g.dedupe_safe);
  const conflicts = duplicateGroups.filter(
    (g) => g.classification === "conflicting_duplicate_different_product" || g.classification === "scope_store_org_mismatch",
  );
  const staleOnly = duplicateGroups.filter((g) => g.classification === "stale_inactive_duplicate");
  const allDedupeSafe = duplicateGroups.length > 0 && duplicateGroups.every((g) => g.dedupe_safe);
  const hasConflicts = conflicts.length > 0;

  const hasCrossSourceConflicts = crossSourceClassified.some(
    (g) => g.product_count > 1 || g.classification === "conflicting_duplicate_different_product",
  );
  const crossSourceSafeDedupe = crossSourceClassified.filter(
    (g) => g.dedupe_safe && g.product_count === 1 && g.match_source_count > 1,
  );

  let blockedReason: string;
  let exactNextPrompt: string;
  let safeToContinue: "yes" | "no" | "yes_with_dedupe_approval";

  const rootCause = nullListingGateTrap.would_fail_without_is_not_null_filter
    ? "false_positive — 21+ wave1-tagged rows share NULL external_listing_id; PostgreSQL GROUP BY NULL caused pre-fix gate FAIL (not true duplicates)"
    : gateDupes.rows.length > 0
      ? "external_listing_id duplicate groups under match_source"
      : crossSourceClassified.length > 0
        ? "cross-match_source seller_sku rows"
        : "none";

  if (
    nullListingGateTrap.would_fail_without_is_not_null_filter &&
    gateDupes.rows.length === 0 &&
    !hasCrossSourceConflicts
  ) {
    blockedReason =
      "Historical FAIL was NULL external_listing_id GROUP BY trap — not true duplicates; current gate query clean";
    exactNextPrompt = "PRODUCT-SHEET-STAGING-APPLY-WAVE1-SAMPLE — re-run verification-only (expect PASS); then WAVE2";
    safeToContinue = "yes";
  } else if (gateDupes.rows.length === 0 && !hasCrossSourceConflicts && crossSourceClassified.length === 0) {
    blockedReason = "none — gate duplicate query returns zero groups; no cross-source seller_sku conflicts for wave SKUs";
    exactNextPrompt = "PRODUCT-SHEET-STAGING-APPLY-WAVE1-SAMPLE — re-run verification (expect PASS on duplicate gate)";
    safeToContinue = "yes";
  } else if (allDedupeSafe) {
    blockedReason = `${gateDupes.rows.length} external_listing_id group(s) — all same-product or inactive-only; soft-delete extras to pass gate`;
    exactNextPrompt = "PRODUCT-SHEET-WAVE1-DUPLICATE-MAP-DEDUPE-STAGING-EXECUTE";
    safeToContinue = "yes_with_dedupe_approval";
  } else if (gateDupes.rows.length === 0 && hasCrossSourceConflicts) {
    blockedReason = `${crossSourceClassified.filter((g) => g.product_count > 1).length} wave SKU(s) map to multiple products across match_sources`;
    exactNextPrompt = "PRODUCT-SHEET-WAVE1-DUPLICATE-MAP-MANUAL-REVIEW";
    safeToContinue = "no";
  } else if (gateDupes.rows.length === 0 && crossSourceSafeDedupe.length > 0) {
    blockedReason = `${crossSourceSafeDedupe.length} wave SKU(s) have redundant same-product map rows across match_sources — optional dedupe before wave2`;
    exactNextPrompt = "PRODUCT-SHEET-WAVE1-CROSS-SOURCE-MAP-DEDUPE-STAGING-EXECUTE";
    safeToContinue = "yes_with_dedupe_approval";
  } else if (conflicts.length > 0) {
    blockedReason = `${conflicts.length} group(s) have different product_id or scope mismatch — manual review before any dedupe`;
    exactNextPrompt = "PRODUCT-SHEET-WAVE1-DUPLICATE-MAP-MANUAL-REVIEW";
    safeToContinue = "no";
  } else {
    blockedReason = `${gateDupes.rows.length} duplicate group(s); mixed stale/active — partial dedupe may suffice`;
    exactNextPrompt = staleOnly.length === duplicateGroups.length
      ? "PRODUCT-SHEET-WAVE1-DUPLICATE-MAP-DEDUPE-STAGING-EXECUTE"
      : "PRODUCT-SHEET-WAVE1-DUPLICATE-MAP-MANUAL-REVIEW";
    safeToContinue = staleOnly.length === duplicateGroups.length ? "yes_with_dedupe_approval" : "no";
  }

  const wave2Blocked =
    gateDupes.rows.length > 0 && !allDedupeSafe
      ? true
      : hasCrossSourceConflicts;

  const report = {
    prompt: "PRODUCT-SHEET-WAVE1-DUPLICATE-MAP-READONLY",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read-only",
    root_cause: rootCause,
    gate_query: {
      match_source: MATCH_SOURCE,
      filter: "external_listing_id IS NOT NULL, no deleted_at filter (matches apply script)",
      duplicate_external_listing_id_groups: gateDupes.rows.length,
    },
    wave1_map_totals: wave1Totals.rows[0],
    null_listing_id_gate_trap: nullListingGateTrap,
    null_listing_id_wave_rows_sample: nullListingIdWaveRows.rows,
    non_null_listing_id_rows: sharedListingIdRows.rows,
    duplicate_groups: duplicateGroups,
    safe_duplicates: safeDuplicates.map((g) => ({
      external_listing_id: g.external_listing_id,
      keep_id: g.keep_id,
      soft_delete_ids: g.soft_delete_ids,
      classification: g.classification,
    })),
    conflicts: conflicts.map((g) => ({
      external_listing_id: g.external_listing_id,
      classification: g.classification,
      product_ids: g.product_ids,
      detail: g.detail,
    })),
    stale_inactive_groups: staleOnly.map((g) => ({
      external_listing_id: g.external_listing_id,
      active_count: g.active_count,
      inactive_count: g.inactive_count,
      dedupe_safe: g.dedupe_safe,
    })),
    wave1_seller_sku_dupes_within_source: wave1SkuDupesWithinSource.rows,
    cross_source_seller_sku_duplicates: crossSourceClassified,
    broader_seller_sku_duplicates_sample: skuDupes.rows.slice(0, 20),
    wave1_seller_sku_multi_map: sampleSkuDupesInWave.rows,
    wave2_gate: {
      blocked_by_wave1_verification: wave2Blocked,
      can_continue_after_dedupe: allDedupeSafe || staleOnly.length === duplicateGroups.length || (!hasCrossSourceConflicts && gateDupes.rows.length === 0),
      must_stay_blocked: hasCrossSourceConflicts,
      note:
        nullListingGateTrap.would_fail_without_is_not_null_filter
          ? "Pre-fix gate FAIL was NULL listing_id bucket — not dedupe-able conflicts"
          : "Gate query clean on current staging",
    },
    blocked_reason: blockedReason,
    exact_next_prompt: exactNextPrompt,
    SAFE_TO_CONTINUE: safeToContinue,
  };

  fs.writeFileSync(path.join(outDir, "audit.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# PRODUCT-SHEET-WAVE1-DUPLICATE-MAP-READONLY",
      "",
      `Run: \`${runId}\` · Staging \`${STAGING_REF}\``,
      "",
      "## Gate failure",
      "",
      `Duplicate \`external_listing_id\` groups (match_source=\`${MATCH_SOURCE}\`): **${gateDupes.rows.length}**`,
      "",
      "## Classification",
      "",
      `| Bucket | Count |`,
      `|--------|------:|`,
      `| Safe dedupe (same product) | ${safeDuplicates.length} |`,
      `| Conflicts | ${conflicts.length} |`,
      `| Stale/inactive | ${staleOnly.length} |`,
      "",
      "## Wave2",
      "",
      `- Blocked until gate passes: **${wave2Blocked ? "yes" : "no"}**`,
      `- Can continue after dedupe approval: **${report.wave2_gate.can_continue_after_dedupe ? "yes" : "no"}**`,
      "",
      "## SAFE_TO_CONTINUE",
      "",
      `**${safeToContinue}**`,
      "",
      `Next: \`${exactNextPrompt}\``,
      "",
      blockedReason ? `Blocked: ${blockedReason}` : "",
    ].join("\n"),
  );

  console.log(
    JSON.stringify(
      {
        duplicate_groups: gateDupes.rows.length,
        safe_duplicates: safeDuplicates.length,
        conflicts: conflicts.length,
        blocked_reason: blockedReason,
        exact_next_prompt: exactNextPrompt,
        SAFE_TO_CONTINUE: safeToContinue,
        outDir,
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
