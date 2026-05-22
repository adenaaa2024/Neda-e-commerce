"use server";

import { randomUUID } from "node:crypto";

import { classifyProductBarcode } from "@/lib/product-barcode-classify";
import type { ProductBarcodeKind } from "@/lib/product-barcode-classify";
import { fetchProductLinkageDisplayContract } from "@/lib/product-linkage-display-enrich";
import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import {
  extractCatalogMainImageAndText,
  fetchAmazonCatalogItemJson,
  getAmazonCatalogAccessToken,
  resolveAmazonCatalogContext,
} from "@/lib/pim-amazon-catalog-enrichment";
import {
  fetchProductIdentifierMapCandidates,
  listAmbiguousProductIdsAtBestTier,
} from "@/lib/product-identifier-match";
import { canonicalItemNameFromLookup } from "@/lib/returns-lookup-field-apply";
import { resolveScannerProductIdentifiers } from "@/lib/scanner-product-resolve";
import { supabaseServer } from "@/lib/supabase-server";
import { supabaseUrlMatchesStagingRef } from "@/lib/staging-project-ref";
import { isUuidString } from "@/lib/uuid";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const SOURCE_TABLE = "product_input_lookup_v193";

export type ProductInputLookupStatus =
  | "local_resolved"
  | "backend_enriched"
  | "ambiguous"
  | "unresolved";

export type AmbiguousProductChoice = {
  product_id: string;
  product_name: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  upc: string | null;
  map_row_count: number;
};

export type ProductInputLookupFields = {
  item_name: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  upc: string | null;
  product_identifier: string | null;
  image_url: string | null;
};

export type ProductInputLookupResult =
  | {
      ok: true;
      status: ProductInputLookupStatus;
      normalized_input: string;
      classified_kind: ProductBarcodeKind;
      fields: ProductInputLookupFields;
      product_linkage: ProductLinkageDisplayContract;
      enrichment: {
        attempted: boolean;
        enabled: boolean;
        reason: string | null;
      };
      ambiguous_candidates?: AmbiguousProductChoice[];
      audit_id: string;
    }
  | { ok: false; error: string };

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function productName(row: Record<string, unknown> | null): string | null {
  return n(row?.product_name) ?? n(row?.name);
}

function imageUrl(row: Record<string, unknown> | null): string | null {
  return n(row?.main_image_url) ?? n(row?.image_url);
}

function classifiedIdentifiers(input: string): {
  kind: ProductBarcodeKind;
  normalized: string;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  upc: string | null;
  product_identifier: string | null;
} {
  const c = classifyProductBarcode(input);
  const base = {
    kind: c.kind,
    normalized: c.normalized,
    asin: null,
    fnsku: null,
    sku: null,
    upc: null,
    product_identifier: c.normalized || null,
  };

  switch (c.kind) {
    case "asin":
      return { ...base, asin: c.normalized };
    case "fnsku":
      return { ...base, fnsku: c.normalized };
    case "upc_ean":
      return { ...base, upc: c.normalized };
    case "sku_msku":
      return { ...base, sku: c.normalized };
    default:
      return base;
  }
}

function lookupFieldsFromProduct(
  product: Record<string, unknown> | null,
  identifiers: ReturnType<typeof classifiedIdentifiers>,
): ProductInputLookupFields {
  const upcVal =
    identifiers.upc ?? n(product?.upc_code) ?? n(product?.barcode) ?? null;
  return {
    item_name: productName(product),
    asin: n(product?.asin) ?? identifiers.asin,
    fnsku: n(product?.fnsku) ?? identifiers.fnsku,
    sku: n(product?.sku) ?? identifiers.sku,
    upc: upcVal,
    product_identifier: upcVal ?? identifiers.product_identifier,
    image_url: imageUrl(product),
  };
}

async function loadAmbiguousProductChoices(input: {
  organizationId: string;
  storeId: string;
  identifiers: ReturnType<typeof classifiedIdentifiers>;
}): Promise<AmbiguousProductChoice[]> {
  const hints = {
    organizationId: input.organizationId,
    storeId: input.storeId,
    fnsku: input.identifiers.fnsku,
    msku: input.identifiers.sku,
    asin: input.identifiers.asin,
    upc: input.identifiers.upc,
  };
  const candidates = await fetchProductIdentifierMapCandidates(
    supabaseServer,
    input.organizationId,
    hints,
  );
  const productIds = listAmbiguousProductIdsAtBestTier(candidates, hints);
  if (productIds.length < 2) return [];

  const rowCountByProduct = new Map<string, number>();
  for (const row of candidates) {
    const pid = n(row.product_id);
    if (!pid || !productIds.includes(pid)) continue;
    rowCountByProduct.set(pid, (rowCountByProduct.get(pid) ?? 0) + 1);
  }

  const { data: products } = await supabaseServer
    .from("products")
    .select("id, product_name, name, asin, fnsku, sku, upc_code, barcode")
    .eq("organization_id", input.organizationId)
    .in("id", productIds);

  const byId = new Map(
    ((products ?? []) as Record<string, unknown>[]).map((p) => [String(p.id), p]),
  );

  return productIds.map((product_id) => {
    const p = byId.get(product_id) ?? null;
    return {
      product_id,
      product_name: productName(p),
      asin: n(p?.asin) ?? input.identifiers.asin,
      fnsku: n(p?.fnsku) ?? input.identifiers.fnsku,
      sku: n(p?.sku) ?? input.identifiers.sku,
      upc: n(p?.upc_code) ?? n(p?.barcode) ?? input.identifiers.upc,
      map_row_count: rowCountByProduct.get(product_id) ?? 1,
    };
  });
}

async function loadProduct(productId: string, organizationId: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabaseServer
    .from("products")
    .select("id, organization_id, store_id, product_name, main_image_url, image_url, asin, fnsku, sku, upc_code, barcode")
    .eq("organization_id", organizationId)
    .eq("id", productId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function auditLookup(input: {
  organizationId: string;
  actorProfileId?: string | null;
  action: string;
  detail: Record<string, unknown>;
}): Promise<string> {
  const auditId = randomUUID();
  try {
    await supabaseServer.from("raw_report_import_audit").insert({
      id: auditId,
      organization_id: input.organizationId,
      user_profile_id: input.actorProfileId && isUuidString(input.actorProfileId) ? input.actorProfileId : null,
      action: input.action,
      entity_id: null,
      detail: input.detail,
    });
  } catch {
    // Lookup must not fail because the audit table is unavailable in a dev clone.
  }
  return auditId;
}

async function buildLookupContract(input: {
  organizationId: string;
  sourceRowId: string;
  identifiers: ReturnType<typeof classifiedIdentifiers>;
  resolved_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
  product: Record<string, unknown> | null;
}): Promise<ProductLinkageDisplayContract> {
  return fetchProductLinkageDisplayContract({
    organizationId: input.organizationId,
    source_table: SOURCE_TABLE,
    source_row_id: input.sourceRowId,
    row: {
      asin: input.identifiers.asin ?? n(input.product?.asin),
      fnsku: input.identifiers.fnsku ?? n(input.product?.fnsku),
      sku: input.identifiers.sku ?? n(input.product?.sku),
      product_identifier:
        input.identifiers.upc ?? input.identifiers.product_identifier ?? n(input.product?.upc_code) ?? n(input.product?.barcode),
      resolved_product_id: input.resolved_product_id,
      resolved_catalog_product_id: null,
      identifier_resolution_status: input.identifier_resolution_status,
      identifier_resolution_confidence: input.identifier_resolution_confidence,
      item_name: productName(input.product) ?? input.identifiers.normalized,
    },
  });
}

async function tryBackendEnrichment(input: {
  organizationId: string;
  storeId: string;
  identifiers: ReturnType<typeof classifiedIdentifiers>;
}): Promise<
  | { ok: false; attempted: boolean; enabled: boolean; reason: string }
  | { ok: true; product: Record<string, unknown>; reason: string }
> {
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const autoCreateEnabled = envFlag("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED");
  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);

  if (!spApiEnabled || !autoCreateEnabled || !stagingOk) {
    return {
      ok: false,
      attempted: false,
      enabled: false,
      reason: !stagingOk
        ? "blocked_non_staging"
        : !spApiEnabled
          ? "amazon_sp_api_disabled"
          : "product_enrichment_auto_create_disabled",
    };
  }

  if (!input.identifiers.asin) {
    return {
      ok: false,
      attempted: true,
      enabled: true,
      reason: "backend_enrichment_currently_requires_asin",
    };
  }

  const ctx = await resolveAmazonCatalogContext(input.organizationId, input.storeId);
  if (!ctx.ok) return { ok: false, attempted: true, enabled: true, reason: ctx.error };
  const token = await getAmazonCatalogAccessToken({ credentials: ctx.credentials });
  if (!token.ok) return { ok: false, attempted: true, enabled: true, reason: token.error };
  const cat = await fetchAmazonCatalogItemJson({
    catalogHost: ctx.catalogHost,
    accessToken: token.accessToken,
    marketplaceIds: ctx.marketplaceIds,
    asin: input.identifiers.asin,
  });
  if (!cat.ok) return { ok: false, attempted: true, enabled: true, reason: cat.error };

  const extracted = extractCatalogMainImageAndText(cat.body);
  const name = extracted.product_name ?? input.identifiers.asin;
  const insertRow = {
    organization_id: input.organizationId,
    store_id: input.storeId,
    product_name: name,
    asin: input.identifiers.asin,
    fnsku: input.identifiers.fnsku,
    sku: input.identifiers.sku,
    upc_code: input.identifiers.upc,
    barcode: input.identifiers.upc,
    main_image_url: extracted.main_image_url,
    image_url: extracted.main_image_url,
    brand: extracted.brand,
    status: "active",
    metadata: {
      source: "amazon_sp_api_catalog_items",
      prompt: "PRODUCT-INPUT-AUTO-LOOKUP-AND-ENRICHMENT-V193",
    },
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };

  const { data: product, error } = await supabaseServer
    .from("products")
    .insert(insertRow)
    .select("id, organization_id, store_id, product_name, main_image_url, image_url, asin, fnsku, sku, upc_code, barcode")
    .single();

  if (error || !product) {
    return { ok: false, attempted: true, enabled: true, reason: error?.message ?? "product_insert_failed" };
  }

  await supabaseServer.from("product_identifier_map").insert({
    organization_id: input.organizationId,
    store_id: input.storeId,
    product_id: (product as { id: string }).id,
    seller_sku: input.identifiers.sku,
    msku: input.identifiers.sku,
    asin: input.identifiers.asin,
    fnsku: input.identifiers.fnsku,
    upc_code: input.identifiers.upc,
    match_source: "product_input_auto_enrichment_v193",
    source_report_type: "product_input_auto_enrichment_v193",
    external_listing_id: `product_input_auto_enrichment_v193:${(product as { id: string }).id}`,
    is_primary: true,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  });

  return { ok: true, product: product as Record<string, unknown>, reason: "amazon_sp_api_catalog_items" };
}

export async function lookupProductInputForReturnItem(input: {
  organizationId: string;
  storeId?: string | null;
  value: string;
  actorProfileId?: string | null;
}): Promise<ProductInputLookupResult> {
  try {
    const organizationId = input.organizationId.trim();
    const storeId = input.storeId?.trim() ?? "";
    if (!isUuidString(organizationId)) return { ok: false, error: "Invalid organization." };
    if (!isUuidString(storeId)) return { ok: false, error: "Select a store before product lookup." };

    const identifiers = classifiedIdentifiers(input.value);
    if (!identifiers.normalized) return { ok: false, error: "Enter a product identifier." };

    const resolution = await resolveScannerProductIdentifiers(supabaseServer, {
      organizationId,
      storeId,
      sku: identifiers.sku,
      asin: identifiers.asin,
      fnsku: identifiers.fnsku,
      upc: identifiers.upc,
      productIdentifier: identifiers.upc ?? identifiers.product_identifier,
    });

    if (resolution.resolved_product_id && resolution.identifier_resolution_status === "resolved") {
      const product = await loadProduct(resolution.resolved_product_id, organizationId);
      const linkage = await buildLookupContract({
        organizationId,
        sourceRowId: identifiers.normalized,
        identifiers,
        resolved_product_id: resolution.resolved_product_id,
        identifier_resolution_status: resolution.identifier_resolution_status,
        identifier_resolution_confidence: resolution.identifier_resolution_confidence,
        product,
      });
      const audit_id = await auditLookup({
        organizationId,
        actorProfileId: input.actorProfileId,
        action: "product_input_lookup_v193_local_resolved",
        detail: { normalized: identifiers.normalized, kind: identifiers.kind, product_id: resolution.resolved_product_id },
      });
      const fields = lookupFieldsFromProduct(product, identifiers);
      fields.item_name =
        canonicalItemNameFromLookup(fields, linkage) ?? fields.item_name;
      return {
        ok: true,
        status: "local_resolved",
        normalized_input: identifiers.normalized,
        classified_kind: identifiers.kind,
        fields,
        product_linkage: linkage,
        enrichment: { attempted: false, enabled: false, reason: null },
        audit_id,
      };
    }

    if (resolution.identifier_resolution_status === "ambiguous") {
      const linkage = await buildLookupContract({
        organizationId,
        sourceRowId: identifiers.normalized,
        identifiers,
        resolved_product_id: null,
        identifier_resolution_status: "ambiguous",
        identifier_resolution_confidence: resolution.identifier_resolution_confidence,
        product: null,
      });
      const audit_id = await auditLookup({
        organizationId,
        actorProfileId: input.actorProfileId,
        action: "product_input_lookup_v193_ambiguous",
        detail: { normalized: identifiers.normalized, kind: identifiers.kind },
      });
      const ambiguous_candidates = await loadAmbiguousProductChoices({
        organizationId,
        storeId,
        identifiers,
      });
      return {
        ok: true,
        status: "ambiguous",
        normalized_input: identifiers.normalized,
        classified_kind: identifiers.kind,
        fields: {
          item_name: null,
          asin: identifiers.asin,
          fnsku: identifiers.fnsku,
          sku: identifiers.sku,
          upc: identifiers.upc,
          product_identifier: identifiers.upc ?? identifiers.product_identifier,
          image_url: null,
        },
        product_linkage: linkage,
        enrichment: { attempted: false, enabled: false, reason: null },
        ambiguous_candidates,
        audit_id,
      };
    }

    const enriched = await tryBackendEnrichment({ organizationId, storeId, identifiers });
    if (enriched.ok) {
      const productId = n(enriched.product.id);
      const linkage = await buildLookupContract({
        organizationId,
        sourceRowId: identifiers.normalized,
        identifiers,
        resolved_product_id: productId,
        identifier_resolution_status: productId ? "resolved" : "unresolved",
        identifier_resolution_confidence: productId ? 1 : null,
        product: enriched.product,
      });
      const audit_id = await auditLookup({
        organizationId,
        actorProfileId: input.actorProfileId,
        action: "product_input_lookup_v193_backend_enriched",
        detail: { normalized: identifiers.normalized, kind: identifiers.kind, product_id: productId, source: enriched.reason },
      });
      const enrichedFields = lookupFieldsFromProduct(enriched.product, identifiers);
      enrichedFields.item_name =
        canonicalItemNameFromLookup(enrichedFields, linkage) ?? enrichedFields.item_name;
      return {
        ok: true,
        status: "backend_enriched",
        normalized_input: identifiers.normalized,
        classified_kind: identifiers.kind,
        fields: enrichedFields,
        product_linkage: linkage,
        enrichment: { attempted: true, enabled: true, reason: enriched.reason },
        audit_id,
      };
    }

    const linkage = await buildLookupContract({
      organizationId,
      sourceRowId: identifiers.normalized,
      identifiers,
      resolved_product_id: null,
      identifier_resolution_status: "unresolved",
      identifier_resolution_confidence: resolution.identifier_resolution_confidence,
      product: null,
    });
    const audit_id = await auditLookup({
      organizationId,
      actorProfileId: input.actorProfileId,
      action: "product_input_lookup_v193_unresolved",
      detail: {
        normalized: identifiers.normalized,
        kind: identifiers.kind,
        enrichment_attempted: enriched.attempted,
        enrichment_enabled: enriched.enabled,
        reason: enriched.reason,
      },
    });

    return {
      ok: true,
      status: "unresolved",
      normalized_input: identifiers.normalized,
      classified_kind: identifiers.kind,
      fields: {
        item_name: null,
        asin: identifiers.asin,
        fnsku: identifiers.fnsku,
        sku: identifiers.sku,
        upc: identifiers.upc,
        product_identifier: identifiers.upc ?? identifiers.product_identifier,
        image_url: null,
      },
      product_linkage: linkage,
      enrichment: { attempted: enriched.attempted, enabled: enriched.enabled, reason: enriched.reason },
      audit_id,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Product lookup failed." };
  }
}

/** Fill add/edit form fields after operator picks one ambiguous local product (V196). */
export async function loadReturnItemLookupFieldsFromProduct(input: {
  organizationId: string;
  productId: string;
}): Promise<
  | { ok: true; fields: ProductInputLookupFields; product_linkage: ProductLinkageDisplayContract }
  | { ok: false; error: string }
> {
  try {
    const organizationId = input.organizationId.trim();
    const productId = input.productId.trim();
    if (!isUuidString(organizationId) || !isUuidString(productId)) {
      return { ok: false, error: "Invalid organization or product." };
    }
    const product = await loadProduct(productId, organizationId);
    if (!product) return { ok: false, error: "Product not found." };
    const identifiers = classifiedIdentifiers(
      n(product.fnsku) ?? n(product.asin) ?? n(product.sku) ?? n(product.upc_code) ?? "",
    );
    const linkage = await buildLookupContract({
      organizationId,
      sourceRowId: productId,
      identifiers,
      resolved_product_id: productId,
      identifier_resolution_status: "resolved",
      identifier_resolution_confidence: 1,
      product,
    });
    const fields = lookupFieldsFromProduct(product, identifiers);
    fields.item_name = canonicalItemNameFromLookup(fields, linkage) ?? fields.item_name;
    return { ok: true, fields, product_linkage: linkage };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to load product." };
  }
}
