/**
 * PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-PILOT-V1 — read-only audit.
 *   npx tsx scripts/phase-claim-physical-return-product-linkage-pilot-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createRequire } from "node:module";
import type { Module } from "node:module";
import { createClient } from "@supabase/supabase-js";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";
import { resolveProductIdentifier } from "../lib/search/product-identifier-resolve";
import { resolveProductIdentifierMapMatch } from "../lib/amazon-operational-product-resolve";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TARGET_FNSKU = "X006OFFM01";
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-product-linkage-pilot-v1";

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

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) throw new Error(`BLOCKED: must target ref ${STAGING_REF}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
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

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pgClient = await connectPg();

  const orgR = await pgClient.query(`
    SELECT organization_id::text AS org, store_id::text AS store, COUNT(*)::int AS n
    FROM public.claim_candidates
    WHERE source_kind <> 'legacy_seed'
      AND fnsku = $1
      AND quarantined_at IS NULL
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 1
  `, [TARGET_FNSKU]);
  const orgId = str((orgR.rows[0] as Row | undefined)?.org);
  const storeId = str((orgR.rows[0] as Row | undefined)?.store);
  if (!orgId) throw new Error(`No active candidates with FNSKU ${TARGET_FNSKU}`);

  const prodCols = await tableColumns(pgClient, "products");
  const catCols = await tableColumns(pgClient, "catalog_products");
  const pimCols = await tableColumns(pgClient, "product_identifier_map");
  const prodNameCol = ["name", "product_name", "title"].find((c) => prodCols.has(c)) ?? "id";
  const catNameCol = ["product_name", "title", "name"].find((c) => catCols.has(c)) ?? "id";

  const candidates = await pgClient.query(
    `SELECT id::text, source_kind, source_table, source_row_id::text, store_id::text,
            fnsku, asin, sku, resolved_product_id::text, metadata, claim_family, claim_reason,
            recovery_value, cogs_unit, evidence_status, candidate_status, package_id::text, return_item_id::text
     FROM public.claim_candidates
     WHERE organization_id = $1 AND fnsku = $2 AND quarantined_at IS NULL
     ORDER BY created_at`,
    [orgId, TARGET_FNSKU],
  );
  const returnItems = await pgClient.query(
    `SELECT ri.id::text, ri.fnsku, ri.asin, ri.sku, ri.product_id::text, ri.package_id::text,
            ri.order_id, ri.item_name, ri.notes, ri.conditions, ri.scanned_quantity,
            ri.organization_id::text, ri.store_id::text, ri.created_at::text
     FROM public.return_items ri
     WHERE ri.organization_id = $1
       AND (ri.fnsku = $2 OR ri.id IN (
         SELECT source_row_id FROM public.claim_candidates
         WHERE organization_id = $1 AND fnsku = $2 AND source_table = 'return_items'
       ))
     ORDER BY ri.created_at`,
    [orgId, TARGET_FNSKU],
  );
  const pimFnsku = pimCols.has("fnsku")
    ? await pgClient.query(
        `SELECT id::text, organization_id::text, store_id::text, product_id::text, catalog_product_id::text,
                fnsku, asin,
                ${pimCols.has("seller_sku") ? "seller_sku" : "NULL AS seller_sku"},
                ${pimCols.has("msku") ? "msku" : "NULL AS msku"},
                ${pimCols.has("upc_code") ? "upc_code" : "NULL AS upc_code"},
                ${pimCols.has("title") ? "title" : "NULL AS title"},
                ${pimCols.has("confidence_score") ? "confidence_score" : "NULL AS confidence_score"},
                ${pimCols.has("match_source") ? "match_source" : "NULL AS match_source"},
                ${pimCols.has("deleted_at") ? "deleted_at::text" : "NULL::text AS deleted_at"}
         FROM public.product_identifier_map
         WHERE organization_id = $1 AND UPPER(TRIM(fnsku)) = UPPER(TRIM($2))
         ORDER BY store_id NULLS LAST`,
        [orgId, TARGET_FNSKU],
      )
    : { rows: [] as Row[] };
  const pimOrg = await pgClient.query(
    `SELECT COUNT(*)::int AS n FROM public.product_identifier_map WHERE organization_id = $1`,
    [orgId],
  );
  const productsFnsku =
    prodCols.has("fnsku")
      ? await pgClient.query(
          `SELECT id::text, organization_id::text, ${prodCols.has("store_id") ? "store_id::text" : "NULL::text AS store_id"},
                  fnsku, asin, sku, ${prodNameCol} AS display_name,
                  ${prodCols.has("cost") ? "cost" : "NULL"} AS cost,
                  ${prodCols.has("unit_cost") ? "unit_cost" : "NULL"} AS unit_cost,
                  ${prodCols.has("deleted_at") ? "deleted_at::text" : "NULL::text AS deleted_at"}
           FROM public.products
           WHERE organization_id = $1 AND UPPER(TRIM(fnsku)) = UPPER(TRIM($2))
           ORDER BY ${prodCols.has("created_at") ? "created_at" : "id"} DESC`,
          [orgId, TARGET_FNSKU],
        )
      : { rows: [] as Row[] };
  const catalogFnsku =
    catCols.has("fnsku")
      ? await pgClient.query(
          `SELECT id::text, organization_id::text, ${catCols.has("store_id") ? "store_id::text" : "NULL::text AS store_id"},
                  fnsku, asin,
                  ${catCols.has("seller_sku") ? "seller_sku" : "NULL AS seller_sku"},
                  ${catCols.has("msku") ? "msku" : "NULL AS msku"},
                  ${catNameCol} AS display_name,
                  ${catCols.has("deleted_at") ? "deleted_at::text" : "NULL::text AS deleted_at"}
           FROM public.catalog_products
           WHERE organization_id = $1 AND UPPER(TRIM(fnsku)) = UPPER(TRIM($2))
           ORDER BY ${catCols.has("created_at") ? "created_at" : "id"} DESC NULLS LAST LIMIT 20`,
          [orgId, TARGET_FNSKU],
        )
      : { rows: [] as Row[] };
  const catalogAsin =
    catCols.has("asin")
      ? await pgClient.query(
          `SELECT id::text, organization_id::text, fnsku, asin,
                  ${catCols.has("seller_sku") ? "seller_sku" : "NULL AS seller_sku"},
                  ${catNameCol} AS display_name
           FROM public.catalog_products
           WHERE organization_id = $1 AND asin IS NOT NULL
             AND asin IN (
               SELECT DISTINCT asin FROM public.return_items
               WHERE organization_id = $1 AND fnsku = $2 AND asin IS NOT NULL
             )
           LIMIT 20`,
          [orgId, TARGET_FNSKU],
        )
      : { rows: [] as Row[] };

  const candRows = candidates.rows as Row[];
  const riRows = returnItems.rows as Row[];
  const pimRows = pimFnsku.rows as Row[];
  const prodRows = productsFnsku.rows as Row[];
  const catRows = [...(catalogFnsku.rows as Row[]), ...(catalogAsin.rows as Row[])];
  const uniqueCat = new Map(catRows.map((r) => [String(r.id), r]));

  const asins = [...new Set([...candRows, ...riRows].map((r) => str(r.asin)).filter(Boolean))] as string[];
  const skus = [...new Set([...candRows, ...riRows].map((r) => str(r.sku)).filter(Boolean))] as string[];

  let catalogByAsin: Row[] = [];
  if (asins.length) {
    const r = await pgClient.query(
      `SELECT id::text, organization_id::text, store_id::text, fnsku, asin, seller_sku, msku, product_name
       FROM public.catalog_products WHERE organization_id = $1 AND asin = ANY($2::text[]) LIMIT 20`,
      [orgId, asins],
    );
    catalogByAsin = r.rows as Row[];
  }

  const ppCols = await tableColumns(pgClient, "product_prices");
  const priceCol = ["sale_price", "price", "unit_price", "list_price"].find((x) => ppCols.has(x)) ?? null;
  const productIds = [
    ...new Set([
      ...pimRows.map((r) => str(r.product_id)).filter(Boolean),
      ...prodRows.map((r) => str(r.id)).filter(Boolean),
      ...riRows.map((r) => str(r.product_id)).filter(Boolean),
    ]),
  ] as string[];

  let priceRows: Row[] = [];
  if (productIds.length && priceCol && ppCols.has("product_id")) {
    const r = await pgClient.query(
      `SELECT product_id::text, ${priceCol}::numeric AS price_value, currency,
              ${ppCols.has("created_at") ? "created_at::text" : "NULL::text AS created_at"},
              ${ppCols.has("store_id") ? "store_id::text" : "NULL::text AS store_id"}
       FROM public.product_prices
       WHERE organization_id = $1 AND product_id = ANY($2::uuid[])
       ORDER BY ${ppCols.has("created_at") ? "created_at" : priceCol} DESC NULLS LAST
       LIMIT 20`,
      [orgId, productIds],
    );
    priceRows = r.rows as Row[];
  }

  const supabaseUrl = process.env.STAGING_SUPABASE_URL?.trim() ?? "";
  const supabaseKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? "";
  if (refFromSupabaseUrl(supabaseUrl) !== STAGING_REF) throw new Error("STAGING_SUPABASE_URL ref mismatch");
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  const resolverSamples = await Promise.all(
    riRows.slice(0, 3).map(async (ri) => {
      const [canonical, mapMatch] = await Promise.all([
        resolveProductIdentifier(supabase, {
          organization_id: orgId,
          store_id: str(ri.store_id) ?? storeId,
          source_table: "return_items",
          source_row_id: str(ri.id),
          fnsku: str(ri.fnsku),
          asin: str(ri.asin),
          sku: str(ri.sku),
        }),
        resolveProductIdentifierMapMatch(supabase, {
          organizationId: orgId,
          storeId: str(ri.store_id) ?? storeId,
          fnsku: str(ri.fnsku),
          asin: str(ri.asin),
          msku: str(ri.sku),
          sku: str(ri.sku),
        }),
      ]);
      return {
        return_item_id: str(ri.id),
        store_id: str(ri.store_id) ?? storeId,
        identifiers: { fnsku: str(ri.fnsku), asin: str(ri.asin), sku: str(ri.sku) },
        resolveProductIdentifier: canonical,
        resolveProductIdentifierMapMatch: {
          status: mapMatch.status,
          tier: mapMatch.tier,
          confidence: mapMatch.confidence,
          candidatesConsidered: mapMatch.candidatesConsidered,
          product_id: mapMatch.row?.product_id ?? null,
          catalog_product_id: mapMatch.row?.catalog_product_id ?? null,
          matched_fnsku: mapMatch.row?.fnsku ?? null,
          matched_asin: mapMatch.row?.asin ?? null,
        },
      };
    }),
  );

  const storeScopedPim = pimRows.filter((r) => !str(r.store_id) || str(r.store_id) === storeId);
  const distinctProductIds = [...new Set(storeScopedPim.map((r) => str(r.product_id)).filter(Boolean))];
  const distinctCatalogIds = [...new Set(storeScopedPim.map((r) => str(r.catalog_product_id)).filter(Boolean))];

  const conflicts: string[] = [];
  if (distinctProductIds.length > 1) conflicts.push(`Multiple product_id in store-scoped PIM: ${distinctProductIds.join(", ")}`);
  if (distinctCatalogIds.length > 1) conflicts.push(`Multiple catalog_product_id in store-scoped PIM: ${distinctCatalogIds.join(", ")}`);
  if (pimRows.length > 1 && distinctProductIds.length === 1) {
    /* same product — ok */
  } else if (pimRows.length > 1 && distinctProductIds.length === 0) {
    conflicts.push("PIM rows exist but none have product_id");
  }

  const resolverUnresolved = resolverSamples.every((s) => s.resolveProductIdentifier.status === "unresolved");
  const mapUnresolved = resolverSamples.every((s) => s.resolveProductIdentifierMapMatch.status === "unresolved");
  const mapAmbiguous = resolverSamples.some((s) => s.resolveProductIdentifierMapMatch.status === "ambiguous");

  const deterministic =
    !mapAmbiguous &&
    distinctProductIds.length === 1 &&
    resolverSamples.some((s) => s.resolveProductIdentifierMapMatch.status === "resolved");

  const proposedMapping =
    deterministic && distinctProductIds[0]
      ? {
          action: "proposed_only_not_applied",
          fnsku: TARGET_FNSKU,
          organization_id: orgId,
          store_id: storeId,
          product_id: distinctProductIds[0],
          catalog_product_id: distinctCatalogIds[0] ?? null,
          matched_via: "product_identifier_map.fnsku (tier 1)",
          candidate_ids_to_enrich: candRows.map((c) => String(c.id)),
          return_item_ids: riRows.map((r) => String(r.id)),
          note: "Separate apply phase would set resolved_product_id on claim_candidates only after Maysam approval — no product auto-create.",
        }
      : null;

  const orgSpineCounts = {
    products: Number(
      ((await pgClient.query(`SELECT COUNT(*)::int AS n FROM public.products WHERE organization_id = $1`, [orgId])).rows[0] as Row)
        ?.n ?? 0,
    ),
    catalog_products: Number(
      (
        await pgClient.query(`SELECT COUNT(*)::int AS n FROM public.catalog_products WHERE organization_id = $1`, [
          orgId,
        ])
      ).rows[0] as Row
    )?.n ?? 0,
    product_identifier_map: Number((pimOrg.rows[0] as Row | undefined)?.n ?? 0),
    product_prices: Number(
      (
        await pgClient.query(`SELECT COUNT(*)::int AS n FROM public.product_prices WHERE organization_id = $1`, [orgId])
      ).rows[0] as Row
    )?.n ?? 0,
  };

  const returnItemDetails = riRows.map((r) => ({
    id: str(r.id),
    fnsku: str(r.fnsku),
    asin: str(r.asin),
    sku: str(r.sku),
    product_id: str(r.product_id),
    item_name_present: Boolean(str(r.item_name)),
    notes_present: Boolean(str(r.notes)),
    conditions: str(r.conditions),
  }));

  const missingData: string[] = [];
  if (orgSpineCounts.product_identifier_map === 0) {
    missingData.push(
      `Entire org has zero product_identifier_map rows — run Amazon listing/inventory import to populate PIM before any FNSKU linkage`,
    );
  } else if (!pimRows.length) {
    missingData.push(`product_identifier_map row for FNSKU ${TARGET_FNSKU} (org ${orgId}, store ${storeId})`);
  }
  if (!prodRows.length && !distinctProductIds.length) missingData.push("products spine row linked to FNSKU (via PIM or direct fnsku column)");
  if (!uniqueCat.size && !catalogByAsin.length) missingData.push("catalog_products row from Amazon listing import for FNSKU/ASIN");
  if (!asins.length && !skus.length) missingData.push("ASIN or MSKU/SKU on return_items or candidates (FNSKU-only scan)");
  if (!priceRows.length) missingData.push(`product_prices row (sale context) for resolved product_id`);
  if (riRows.every((r) => !str(r.product_id))) missingData.push("return_items.product_id not set at scan time");

  const identifierInventory = {
    fnsku: TARGET_FNSKU,
    asins_on_candidates: [...new Set(candRows.map((c) => str(c.asin)).filter(Boolean))],
    asins_on_return_items: [...new Set(riRows.map((r) => str(r.asin)).filter(Boolean))],
    skus_on_candidates: [...new Set(candRows.map((c) => str(c.sku)).filter(Boolean))],
    skus_on_return_items: [...new Set(riRows.map((r) => str(r.sku)).filter(Boolean))],
    msku: skus,
    organization_id: orgId,
    store_id: storeId,
    candidate_count: candRows.length,
    return_item_count: riRows.length,
    pim_org_total_rows: Number((pimOrg.rows[0] as Row | undefined)?.n ?? 0),
    org_spine_counts: orgSpineCounts,
    return_item_details: returnItemDetails,
    title_only_match_forbidden: true,
    note: "item_name on return_items exists for display only — not used for resolver matching per governance.",
  };

  const safeToApply = deterministic && conflicts.length === 0 && proposedMapping != null;

  const result = {
    audit: "PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-PILOT-V1",
    run_id: stamp(),
    organization_id: orgId,
    store_id: storeId,
    target_fnsku: TARGET_FNSKU,
    identifier_inventory: identifierInventory,
    existing_mapping_status: {
      product_identifier_map_rows: pimRows,
      store_scoped_pim_count: storeScopedPim.length,
      distinct_product_ids: distinctProductIds,
      distinct_catalog_product_ids: distinctCatalogIds,
      products_fnsku_rows: prodRows,
      return_items_product_id_set: riRows.map((r) => ({ id: str(r.id), product_id: str(r.product_id) })),
    },
    candidate_product_link_status: candRows.map((c) => ({
      candidate_id: String(c.id),
      source_kind: c.source_kind,
      resolved_product_id: str(c.resolved_product_id),
      fnsku: str(c.fnsku),
      asin: str(c.asin),
      sku: str(c.sku),
      metadata_keys: c.metadata && typeof c.metadata === "object" ? Object.keys(c.metadata as object) : [],
    })),
    catalog_product_match_status: {
      by_fnsku: catalogFnsku.rows,
      by_asin: catalogByAsin,
      unique_catalog_count: uniqueCat.size + catalogByAsin.length,
    },
    price_context_status: {
      price_column_used: priceCol,
      rows: priceRows,
      product_ids_checked: productIds,
    },
    resolver_output: resolverSamples,
    deterministic_match: deterministic ? "yes" : "no",
    conflict_report: conflicts,
    proposed_mapping_if_safe: proposedMapping,
    missing_data_if_not_safe: safeToApply ? [] : missingData,
    Product_Story_impact: deterministic
      ? "Product Story preview can link once resolved_product_id is applied on candidates; TRID product_link edges become materializable."
      : "Product Story blocked — no canonical product_id; preview shows Product not matched.",
    Claim_Center_impact: deterministic
      ? "Find Money may show COGS-based recovery after candidate enrichment; Product queue clears; References/TRID can proceed."
      : "All 4 physical return candidates remain product-blocked; money stays Cost unknown/Unpriced; Product Match queue primary blocker.",
    SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT: safeToApply ? "yes" : "no",
    APPROVAL_REQUIRED_FROM_MAYSAM: "yes",
    pilot_plan: {
      phase_1_data_ingest:
        "Import Amazon listing or inventory report for store 9adfe198 — populate catalog_products + product_identifier_map with FNSKU X006OFFM01 → product_id (existing import path; no resolver rewrite).",
      phase_2_verify:
        "Re-run this audit; require deterministic_match=yes and zero conflicts before apply.",
      phase_3_apply_maysam_gated:
        "PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-APPLY-V1 — set claim_candidates.resolved_product_id only; optional return_items.product_id backfill; no product create; no title/OCR matching.",
      alternative_manual_path:
        "Operator confirms ASIN/MSKU in Product Hub search UI and links via existing product-match queue (read-only until Maysam approves write bridge).",
    },
    NEXT_EXACT_PROMPT:
      orgSpineCounts.product_identifier_map === 0
        ? "PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-DATA-INGEST-V1 (populate product_identifier_map via Amazon listing/inventory import for smoke org store; then re-audit FNSKU X006OFFM01)"
        : safeToApply
          ? "PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-APPLY-V1 (Maysam-approved: enrich claim_candidates.resolved_product_id only; no product create; no PIM mutation)"
          : "PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-DATA-INGEST-V1 (import listing/PIM row for FNSKU X006OFFM01 before apply)",
  };

  const runId = result.run_id;
  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Physical return product linkage pilot V1\n\n- FNSKU: **${TARGET_FNSKU}**\n- deterministic_match: **${result.deterministic_match}**\n- SAFE_TO_APPLY: **${result.SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT}**\n- conflicts: ${conflicts.length}\n`,
  );

  await pgClient.end();
  console.log(JSON.stringify({
    run_id: runId,
    deterministic_match: result.deterministic_match,
    SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT: result.SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT,
    conflicts: conflicts.length,
    pim_rows: pimRows.length,
    distinct_product_ids: distinctProductIds.length,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
