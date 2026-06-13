/**
 * PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-LINKAGE-DRYRUN-V1 — read-only linkage dry-run.
 *   npx tsx scripts/phase-claim-physical-return-real-fnsku-linkage-dryrun-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createRequire } from "node:module";
import type { Module } from "node:module";
import { createClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";
import { resolveProductIdentifier } from "../lib/search/product-identifier-resolve";
import { resolveProductIdentifierMapMatch } from "../lib/amazon-operational-product-resolve";
import { pickBestProductIdentifierMatch, fetchProductIdentifierMapCandidates } from "../lib/product-identifier-match";
import { buildCandidateMoneyProjection } from "../lib/claims/center/claim-center-candidate-money";
import { isSafeForProductStory } from "../lib/claims/center/claim-center-ui-copy";
import type { ClaimCenterV1Row } from "../lib/claims/center/claim-center-v1-types";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-real-fnsku-linkage-dryrun-v1";

/** From PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-SMOKE-TARGET-V1 best_recommended_target */
const TARGET = {
  fnsku: "B0000B11UX",
  asin: "B0000B11UX",
  sku_msku: "X0036MJ5ZB",
  product_id: "8beddd08-4133-48fb-abc1-279e61af8caf",
  store_id: "509ee1f6-622c-46a5-8110-7b889ba46c2c",
  organization_id: "00000000-0000-0000-0000-000000000001",
};

type Row = Record<string, unknown>;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) throw new Error(`BLOCKED: must target ref ${STAGING_REF}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = on");
  return c;
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function simulatePhysicalReturnRow(resolvedProductId: string | null): ClaimCenterV1Row {
  return {
    id: "dryrun-simulated-candidate",
    organization_id: TARGET.organization_id,
    store_id: TARGET.store_id,
    source_kind: "scanner_physical_review",
    source_table: "return_items",
    source_row_id: "dryrun-simulated-return-item",
    claim_family: "physical_return_issue",
    claim_reason: "scanned_off_manifest_unit",
    event_date: new Date().toISOString(),
    reference_id: null,
    reference_type: null,
    recovery_value: null,
    cogs_unit: null,
    currency: "USD",
    sku: TARGET.sku_msku,
    fnsku: TARGET.fnsku,
    asin: TARGET.asin,
    resolved_product_id: resolvedProductId,
    candidate_status: "detected",
    evidence_status: "missing",
    v1_status_group: resolvedProductId ? "needs_review" : "blocked_product_link",
    v1_status_label: resolvedProductId ? "Needs review" : "Blocked — product",
    lifecycle_status: resolvedProductId ? "needs_review" : "product_blocked",
    lifecycle_status_label: resolvedProductId ? "Needs review" : "Product blocked",
    inbox_queue: resolvedProductId ? "ready_for_review" : "needs_product_link",
    final_bucket: resolvedProductId ? "safe_update_candidate" : "unresolved_no_identifiers",
    automation_allowed: false,
    reason_codes: [],
    badges: [],
    canonical_window: { status: "open", days_remaining: 90, deadline: null },
    source_observed_window: null,
    orbit_evidence_summary: null,
    orbit_external_case_status: null,
    orbit_case_group: null,
    amazon_reference_id: null,
    reference_edge_count: 0,
    ambiguity_pending: false,
    product_linkage: resolvedProductId
      ? {
          source_row_id: "dryrun-simulated-return-item",
          source_table: "return_items",
          asin: TARGET.asin,
          fnsku: TARGET.fnsku,
          sku: TARGET.sku_msku,
          upc: null,
          product_id: null,
          resolved_product_id: resolvedProductId,
          resolved_catalog_product_id: null,
          product_name: null,
          identifier_resolution_status: "resolved",
          identifier_resolution_confidence: 0.95,
          is_resolved: true,
          fallback_display_name: TARGET.fnsku,
        }
      : {
          source_row_id: "dryrun-simulated-return-item",
          source_table: "return_items",
          asin: TARGET.asin,
          fnsku: TARGET.fnsku,
          sku: TARGET.sku_msku,
          upc: null,
          product_id: null,
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          product_name: null,
          identifier_resolution_status: "unresolved",
          identifier_resolution_confidence: null,
          is_resolved: false,
          fallback_display_name: TARGET.fnsku,
        },
    product_unresolved_reason: resolvedProductId ? null : "No product link resolved",
    product_story_href: resolvedProductId
      ? `/dashboard/products?search=${encodeURIComponent(TARGET.asin ?? TARGET.fnsku)}`
      : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pgClient = await connectPg();

  const supabaseUrl = process.env.STAGING_SUPABASE_URL?.trim() ?? "";
  const supabaseKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? "";
  if (refFromSupabaseUrl(supabaseUrl) !== STAGING_REF) throw new Error("STAGING_SUPABASE_URL ref mismatch");
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  const baseInput = {
    organization_id: TARGET.organization_id,
    store_id: TARGET.store_id,
    source_table: "return_items",
    source_row_id: "dryrun-simulated-return-item",
  };

  const [byFnsku, byAsin, bySku, byAll, mapMatch, pimPool] = await Promise.all([
    resolveProductIdentifier(supabase, { ...baseInput, fnsku: TARGET.fnsku }),
    resolveProductIdentifier(supabase, { ...baseInput, asin: TARGET.asin }),
    resolveProductIdentifier(supabase, { ...baseInput, sku: TARGET.sku_msku, msku: TARGET.sku_msku }),
    resolveProductIdentifier(supabase, {
      ...baseInput,
      fnsku: TARGET.fnsku,
      asin: TARGET.asin,
      sku: TARGET.sku_msku,
      msku: TARGET.sku_msku,
    }),
    resolveProductIdentifierMapMatch(supabase, {
      organizationId: TARGET.organization_id,
      storeId: TARGET.store_id,
      fnsku: TARGET.fnsku,
      asin: TARGET.asin,
      msku: TARGET.sku_msku,
      sku: TARGET.sku_msku,
    }),
    fetchProductIdentifierMapCandidates(supabase, TARGET.organization_id, {
      storeId: TARGET.store_id,
      fnsku: TARGET.fnsku,
      asin: TARGET.asin,
      msku: TARGET.sku_msku,
      sku: TARGET.sku_msku,
    }),
  ]);

  const mapPick = pickBestProductIdentifierMatch(pimPool, {
    organizationId: TARGET.organization_id,
    storeId: TARGET.store_id,
    fnsku: TARGET.fnsku,
    asin: TARGET.asin,
    msku: TARGET.sku_msku,
    sku: TARGET.sku_msku,
  });

  const distinctPimProducts = [
    ...new Set(pimPool.map((r) => str(r.product_id)).filter(Boolean)),
  ] as string[];

  const ppCols = await tableColumns(pgClient, "product_prices");
  const prodCols = await tableColumns(pgClient, "products");
  const priceCol = ["sale_price", "price", "unit_price", "list_price"].find((x) => ppCols.has(x)) ?? "price";
  const costCol = ["cost", "unit_cost", "cogs", "cost_price", "purchase_price"].find((x) => prodCols.has(x)) ?? null;

  const [priceRow, prodRow, catalogRows, pimExact] = await Promise.all([
    ppCols.has("product_id")
      ? pgClient.query(
          `SELECT ${priceCol}::numeric AS price_value, currency,
                  ${ppCols.has("created_at") ? "created_at::text" : "NULL::text AS created_at"}
           FROM public.product_prices
           WHERE product_id = $1::uuid AND ${priceCol} IS NOT NULL
           ORDER BY ${ppCols.has("created_at") ? "created_at" : priceCol} DESC NULLS LAST LIMIT 1`,
          [TARGET.product_id],
        )
      : Promise.resolve({ rows: [] as Row[] }),
    pgClient.query(
      `SELECT id::text, asin, sku, fnsku,
              ${costCol ? `${costCol}::numeric` : "NULL::numeric"} AS unit_cost
       FROM public.products WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1`,
      [TARGET.product_id],
    ),
    pgClient.query(
      `SELECT id::text, fnsku, asin, seller_sku, price::numeric AS catalog_price
       FROM public.catalog_products
       WHERE organization_id = $1::uuid
         AND (upper(btrim(fnsku)) = upper(btrim($2))
              OR (asin IS NOT NULL AND btrim(asin) = btrim($3))
              OR (seller_sku IS NOT NULL AND btrim(seller_sku) = btrim($4)))
       LIMIT 5`,
      [TARGET.organization_id, TARGET.fnsku, TARGET.asin, TARGET.sku_msku],
    ),
    pgClient.query(
      `SELECT id::text, product_id::text, fnsku, asin, seller_sku, msku, match_source, confidence_score
       FROM public.product_identifier_map
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND upper(btrim(fnsku)) = upper(btrim($3))`,
      [TARGET.organization_id, TARGET.store_id, TARGET.fnsku],
    ),
  ]);

  const resolvedId = byAll.resolved_product_id ?? mapMatch.row?.product_id ?? null;
  const deterministic =
    resolvedId === TARGET.product_id &&
    byAll.status === "resolved" &&
    mapMatch.status === "resolved" &&
    distinctPimProducts.length === 1 &&
    distinctPimProducts[0] === TARGET.product_id;

  const conflicts: string[] = [];
  if (distinctPimProducts.length > 1) {
    conflicts.push(`Multiple product_id for FNSKU in store PIM: ${distinctPimProducts.join(", ")}`);
  }
  if (resolvedId && resolvedId !== TARGET.product_id) {
    conflicts.push(`Resolver product_id ${resolvedId} differs from smoke-target ${TARGET.product_id}`);
  }
  if (byFnsku.status === "ambiguous" || byAsin.status === "ambiguous" || mapMatch.status === "ambiguous") {
    conflicts.push("Ambiguous match on one or more identifier paths");
  }

  const blockers: string[] = [];
  if (!deterministic) blockers.push("Resolver did not produce single deterministic product_id match");
  if (conflicts.length) blockers.push(...conflicts);

  const warnings: string[] = [];
  if (byFnsku.status !== "resolved") {
    warnings.push(
      "FNSKU-only exact path unresolved in resolveProductIdentifier — combined bundle (FNSKU+ASIN+SKU) resolves via seller_sku tier; ensure scan captures ASIN/MSKU or verify PIM fnsku tier-1 lookup",
    );
  }

  const priceVal = num((priceRow.rows[0] as Row | undefined)?.price_value);
  const costVal = num((prodRow.rows[0] as Row | undefined)?.unit_cost);
  const catalogList = catalogRows.rows as Row[];

  const simRow = simulatePhysicalReturnRow(resolvedId);
  const moneyBase = buildCandidateMoneyProjection(simRow);
  const money_display_preview = {
    ...moneyBase,
    latest_sale_price_context: priceVal,
    sale_price_context_note: priceVal != null
      ? `Latest sale price $${priceVal} available as context only — not used as COGS or recovery`
      : "No sale price context",
    cost_remains_unknown: costVal == null && simRow.cogs_unit == null,
    never_use_sale_as_cost: true,
  };

  const product_story_preview = {
    is_safe: isSafeForProductStory(simRow),
    href: simRow.product_story_href,
    blocker: isSafeForProductStory(simRow) ? null : "Product not matched — linkage unresolved",
    requires_resolved_product_id: true,
  };

  const trid_product_edge_preview = {
    edge_type: "product_link",
    reference_kind: "product_id",
    reference_value: resolvedId,
    to_source_table: "products",
    to_source_row_id: resolvedId,
    confidence: resolvedId ? 1.0 : 0,
    would_materialize: Boolean(resolvedId),
    blocker: resolvedId ? null : "product_id unresolved — TRID product_link edge blocked",
    dedupe_key: resolvedId ? `product_link:product_id:${resolvedId}` : null,
  };

  const identifier_match_result = {
    fnsku_exact: {
      input: TARGET.fnsku,
      result: byFnsku,
      matches_expected_product: byFnsku.resolved_product_id === TARGET.product_id,
    },
    asin_exact: {
      input: TARGET.asin,
      result: byAsin,
      matches_expected_product: byAsin.resolved_product_id === TARGET.product_id,
    },
    sku_msku_exact: {
      input: TARGET.sku_msku,
      result: bySku,
      matches_expected_product: bySku.resolved_product_id === TARGET.product_id,
    },
    combined_physical_return_bundle: {
      input: { fnsku: TARGET.fnsku, asin: TARGET.asin, sku: TARGET.sku_msku },
      result: byAll,
      matches_expected_product: byAll.resolved_product_id === TARGET.product_id,
    },
    operational_map_match: mapMatch,
    pick_best_from_pool: mapPick,
    pim_exact_rows: pimExact.rows,
    distinct_pim_product_ids: distinctPimProducts,
  };

  const safeToApply =
    deterministic &&
    conflicts.length === 0 &&
    product_story_preview.is_safe &&
    trid_product_edge_preview.would_materialize;

  const result = {
    audit: "PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-LINKAGE-DRYRUN-V1",
    run_id: stamp(),
    mode: "read_only_dryrun",
    selected_real_fnsku: TARGET,
    identifier_match_result,
    deterministic_match: deterministic ? "yes" : "no",
    product_id: resolvedId ?? TARGET.product_id,
    product_price_context: {
      available: priceVal != null,
      latest_sale_price: priceVal,
      currency: str((priceRow.rows[0] as Row | undefined)?.currency) ?? "USD",
      column: priceCol,
      context_only: true,
      never_used_as_cogs: true,
    },
    catalog_context: {
      rows_found: catalogList.length,
      rows: catalogList,
      available: catalogList.length > 0,
    },
    cost_context: {
      products_cost_column: costCol,
      unit_cost: costVal,
      cogs_on_candidate: null,
      cost_unknown: costVal == null,
    },
    product_story_preview,
    trid_product_edge_preview,
    money_display_preview,
    conflicts,
    blockers,
    warnings,
    simulation_note:
      "Dry-run simulates post-scan physical return row in main org with real FNSKU identifiers — no DB writes, no claim_candidates mutation.",
    SAFE_TO_APPLY_REAL_FNSKU_PHYSICAL_RETURN_LINKAGE: safeToApply ? "yes" : "no",
    NEXT_EXACT_PROMPT: safeToApply
      ? "PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-RESCAN-SMOKE-V1 (main org operator scan FNSKU B0000B11UX; read-only Claim Center verify product linkage + money + TRID preview)"
      : "PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-LINKAGE-REPAIR-V1 (resolve blockers before re-scan)",
  };

  const runId = result.run_id;
  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# Real FNSKU linkage dry-run V1\n\n- FNSKU: **${TARGET.fnsku}**\n- deterministic: **${result.deterministic_match}**\n- SAFE_TO_APPLY: **${result.SAFE_TO_APPLY_REAL_FNSKU_PHYSICAL_RETURN_LINKAGE}**\n`,
  );

  await pgClient.end();
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        deterministic_match: result.deterministic_match,
        product_id: result.product_id,
        SAFE_TO_APPLY: result.SAFE_TO_APPLY_REAL_FNSKU_PHYSICAL_RETURN_LINKAGE,
        conflicts: conflicts.length,
        blockers: blockers.length,
      },
      null,
      2,
    ),
  );
  if (!deterministic) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
