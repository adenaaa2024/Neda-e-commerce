import type { SupabaseClient } from "@supabase/supabase-js";

import { AMAZON_PRODUCT_SYNC_MATCH_SOURCE } from "./amazon-product-sync-recovery-types";
import { upsertPrimaryIdentifierMapForPim } from "./pim-product-map-upsert";

export type AmazonPromoteCandidate = {
  asin: string;
  seller_sku: string | null;
  fnsku: string | null;
  product_name: string;
  source_table: "catalog_products" | "amazon_fba_inventory";
};

export type AmazonPromoteBatchResult = {
  attempted: number;
  created: number;
  skipped: number;
  failed: number;
  created_product_ids: string[];
  errors: Array<{ asin: string; reason: string }>;
};

function normalizeAsin(v: string | null | undefined): string | null {
  const s = v?.trim().toUpperCase();
  return s && /^[A-Z0-9]{10}$/.test(s) ? s : null;
}

/**
 * Distinct ASINs present in Amazon catalog layers but absent from `products` for org+store.
 */
export async function listMissingAmazonProductCandidates(params: {
  supabase: SupabaseClient;
  organizationId: string;
  storeId: string;
  limit: number;
}): Promise<AmazonPromoteCandidate[]> {
  const limit = Math.max(1, Math.min(500, params.limit));
  const out: AmazonPromoteCandidate[] = [];
  const seen = new Set<string>();

  const { data: catalogRows, error: catErr } = await params.supabase
    .from("catalog_products")
    .select("asin, seller_sku, fnsku, item_name")
    .eq("organization_id", params.organizationId)
    .eq("store_id", params.storeId)
    .not("asin", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(limit * 3);

  if (catErr) throw new Error(`catalog_products query failed: ${catErr.message}`);

  for (const row of catalogRows ?? []) {
    const asin = normalizeAsin((row as { asin?: string }).asin);
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);

    const { count } = await params.supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", params.organizationId)
      .eq("store_id", params.storeId)
      .is("deleted_at", null)
      .ilike("asin", asin);

    if ((count ?? 0) > 0) continue;

    out.push({
      asin,
      seller_sku: (row as { seller_sku?: string }).seller_sku?.trim() || null,
      fnsku: (row as { fnsku?: string }).fnsku?.trim() || null,
      product_name: (row as { item_name?: string }).item_name?.trim() || asin,
      source_table: "catalog_products",
    });
    if (out.length >= limit) return out;
  }

  const { data: fbaRows, error: fbaErr } = await params.supabase
    .from("amazon_fba_inventory")
    .select("asin, fnsku, sku, product_name")
    .eq("organization_id", params.organizationId)
    .eq("store_id", params.storeId)
    .not("asin", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit * 3);

  if (fbaErr) {
    // Table may not exist on all environments — ignore missing-relation style errors.
    if (!/does not exist|relation/i.test(fbaErr.message)) {
      throw new Error(`amazon_fba_inventory query failed: ${fbaErr.message}`);
    }
    return out;
  }

  for (const row of fbaRows ?? []) {
    const asin = normalizeAsin((row as { asin?: string }).asin);
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);

    const { count } = await params.supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", params.organizationId)
      .eq("store_id", params.storeId)
      .is("deleted_at", null)
      .ilike("asin", asin);

    if ((count ?? 0) > 0) continue;

    out.push({
      asin,
      seller_sku: (row as { sku?: string }).sku?.trim() || null,
      fnsku: (row as { fnsku?: string }).fnsku?.trim() || null,
      product_name: (row as { product_name?: string }).product_name?.trim() || asin,
      source_table: "amazon_fba_inventory",
    });
    if (out.length >= limit) break;
  }

  return out;
}

/**
 * Auto-create missing Amazon products from catalog/FBA layers (staging-gated by caller).
 * Does not call SP-API — enrichment batch handles catalog refresh afterward.
 */
export async function promoteMissingAmazonProducts(params: {
  supabase: SupabaseClient;
  organizationId: string;
  storeId: string;
  limit: number;
  dryRun?: boolean;
}): Promise<AmazonPromoteBatchResult> {
  const candidates = await listMissingAmazonProductCandidates(params);
  const result: AmazonPromoteBatchResult = {
    attempted: candidates.length,
    created: 0,
    skipped: 0,
    failed: 0,
    created_product_ids: [],
    errors: [],
  };

  if (params.dryRun || candidates.length === 0) {
    result.skipped = candidates.length;
    return result;
  }

  const now = new Date().toISOString();

  for (const c of candidates) {
    const { data: dup, error: dupErr } = await params.supabase
      .from("products")
      .select("id")
      .eq("organization_id", params.organizationId)
      .eq("store_id", params.storeId)
      .is("deleted_at", null)
      .ilike("asin", c.asin)
      .limit(2);

    if (dupErr) {
      result.failed += 1;
      result.errors.push({ asin: c.asin, reason: dupErr.message });
      continue;
    }
    if ((dup?.length ?? 0) > 0) {
      result.skipped += 1;
      continue;
    }

    const { data: product, error: pErr } = await params.supabase
      .from("products")
      .insert({
        organization_id: params.organizationId,
        store_id: params.storeId,
        product_name: c.product_name,
        asin: c.asin,
        fnsku: c.fnsku,
        sku: c.seller_sku,
        status: "active",
        metadata: {
          source: AMAZON_PRODUCT_SYNC_MATCH_SOURCE,
          promote_source_table: c.source_table,
        },
        first_seen_at: now,
        last_seen_at: now,
      })
      .select("id")
      .single();

    if (pErr || !product) {
      result.failed += 1;
      result.errors.push({ asin: c.asin, reason: pErr?.message ?? "product_insert_failed" });
      continue;
    }

    const productId = String((product as { id: string }).id);
    const mapResult = await upsertPrimaryIdentifierMapForPim({
      supabase: params.supabase,
      organizationId: params.organizationId,
      storeId: params.storeId,
      productId,
      identifiers: {
        seller_sku: c.seller_sku,
        asin: c.asin,
        fnsku: c.fnsku,
        upc_code: null,
      },
    });

    if (!mapResult.ok) {
      result.failed += 1;
      result.errors.push({ asin: c.asin, reason: mapResult.error });
      continue;
    }

    await params.supabase
      .from("product_identifier_map")
      .update({
        match_source: AMAZON_PRODUCT_SYNC_MATCH_SOURCE,
        source_report_type: AMAZON_PRODUCT_SYNC_MATCH_SOURCE,
        external_listing_id: `${AMAZON_PRODUCT_SYNC_MATCH_SOURCE}:${productId}`,
      })
      .eq("organization_id", params.organizationId)
      .eq("store_id", params.storeId)
      .eq("product_id", productId);

    result.created += 1;
    result.created_product_ids.push(productId);
  }

  return result;
}
