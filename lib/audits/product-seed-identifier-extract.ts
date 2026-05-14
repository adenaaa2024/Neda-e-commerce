/**
 * NEXT-18B — pure identifier extraction + normalisation for product-seed audit.
 *
 * No Supabase imports. No I/O. Each `extractFrom*Row` returns a normalised
 * (identifiers, identifierSources, shape) triple aligned with the classifier
 * input type. Shape regexes match lib/product-identity-import.ts so the audit
 * stays in lockstep with the PIM importer's accept/reject decisions.
 *
 * Slice scope: only `catalog_products` is wired. The other 13 source tables
 * call `extractNotImplemented(table)` and the orchestrator rejects them with
 * a clear error so an operator does not silently run a partial audit.
 */

import type {
  IdentifierMap,
  IdentifierSource,
  ShapeValidationResult,
} from "./product-seed-classifier";

/** Excel formula-error tokens + placeholders that lib/product-identity-import.ts rejects (lines 200-217). */
export const IDENTIFIER_IGNORE_VALUES: ReadonlySet<string> = new Set([
  "",
  "x",
  "0",
  "fbm",
  "this one is good",
  "unknown",
  "null",
  "#name?",
  "#ref!",
  "#value!",
  "#div/0!",
  "#n/a",
  "#null!",
  "#num!",
]);

export const ASIN_RE = /^B[0-9A-Z]{9}$/;
export const FNSKU_RE = /^X[0-9A-Z]{9}$/;
export const UPC_RE = /^[0-9]{8,14}$/;

export type NormalizeResult = {
  value: string | null;
  shape: "valid" | "invalid" | "absent";
};

function trimAndIgnore(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (IDENTIFIER_IGNORE_VALUES.has(t.toLowerCase())) return null;
  return t || null;
}

export function normalizeAsin(raw: string | null | undefined): NormalizeResult {
  const t = trimAndIgnore(raw);
  if (t == null) return { value: null, shape: "absent" };
  const u = t.toUpperCase();
  if (!ASIN_RE.test(u)) return { value: t, shape: "invalid" };
  return { value: u, shape: "valid" };
}

export function normalizeFnsku(raw: string | null | undefined): NormalizeResult {
  const t = trimAndIgnore(raw);
  if (t == null) return { value: null, shape: "absent" };
  const u = t.toUpperCase();
  if (!FNSKU_RE.test(u)) return { value: t, shape: "invalid" };
  return { value: u, shape: "valid" };
}

export function normalizeUpc(raw: string | null | undefined): NormalizeResult {
  const t = trimAndIgnore(raw);
  if (t == null) return { value: null, shape: "absent" };
  if (!UPC_RE.test(t)) return { value: t, shape: "invalid" };
  return { value: t, shape: "valid" };
}

/**
 * Seller SKU validation here is intentionally lighter than backend-python/pim_seed_cleaning.py.
 * The audit accepts any non-empty seller_sku that is not in IDENTIFIER_IGNORE_VALUES; the
 * date-shaped reject rule (`validate_seller_sku_token`) lives in the PIM apply pipeline and
 * would be redundant for catalog_products rows since they're already in the canonical catalog.
 */
export function normalizeSellerSku(raw: string | null | undefined): NormalizeResult {
  const t = trimAndIgnore(raw);
  if (t == null) return { value: null, shape: "absent" };
  return { value: t, shape: "valid" };
}

export function normalizeListingId(raw: string | null | undefined): NormalizeResult {
  const t = trimAndIgnore(raw);
  if (t == null) return { value: null, shape: "absent" };
  return { value: t, shape: "valid" };
}

export function normalizeTitle(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  return t || null;
}

/**
 * Shape of a `catalog_products` row as projected by the orchestrator.
 * Only fields the audit needs are listed.
 */
export type CatalogProductsRowProjection = {
  id: string;
  organization_id: string | null;
  store_id: string | null;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
  listing_id: string | null;
  item_name: string | null;
  source_upload_id: string | null;
  raw_payload: unknown;
};

export type ExtractedIdentifiers = {
  identifiers: IdentifierMap;
  identifierSources: IdentifierSource;
  shape: ShapeValidationResult;
};

function rawPayloadString(raw: unknown, ...keys: string[]): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const s = typeof v === "string" ? v : String(v);
    if (s.trim()) return s;
  }
  return null;
}

/**
 * `catalog_products` has native seller_sku/asin/fnsku/listing_id/item_name. UPC is
 * never native on this table; it lives in `raw_payload` if the listing report
 * included one.
 */
export function extractFromCatalogProductsRow(
  row: CatalogProductsRowProjection,
): ExtractedIdentifiers {
  const identifiers: IdentifierMap = {};
  const sources: IdentifierSource = {};
  const shape: ShapeValidationResult = {
    seller_sku: "absent",
    asin: "absent",
    fnsku: "absent",
    upc: "absent",
    listing_id: "absent",
  };

  const sellerSku = normalizeSellerSku(row.seller_sku);
  if (sellerSku.value) {
    identifiers.seller_sku = sellerSku.value;
    sources.seller_sku = "native";
  }
  shape.seller_sku = sellerSku.shape;

  const asin = normalizeAsin(row.asin);
  if (asin.value) {
    identifiers.asin = asin.value;
    sources.asin = "native";
  }
  shape.asin = asin.shape;

  const fnsku = normalizeFnsku(row.fnsku);
  if (fnsku.value) {
    identifiers.fnsku = fnsku.value;
    sources.fnsku = "native";
  }
  shape.fnsku = fnsku.shape;

  // UPC: catalog_products has no native upc column, only raw_payload.
  const upcRaw = rawPayloadString(row.raw_payload, "upc", "upc-code", "upc_code", "UPC", "gtin", "GTIN");
  const upc = normalizeUpc(upcRaw);
  if (upc.value && upc.shape === "valid") {
    identifiers.upc = upc.value;
    sources.upc = "raw_payload";
  } else if (upc.shape === "invalid") {
    identifiers.upc = upc.value;
    sources.upc = "raw_payload";
  }
  shape.upc = upc.shape;

  const listingId = normalizeListingId(row.listing_id);
  if (listingId.value) {
    identifiers.listing_id = listingId.value;
    sources.listing_id = "native";
  }
  shape.listing_id = listingId.shape;

  const title = normalizeTitle(row.item_name);
  if (title) {
    identifiers.title = title;
    sources.title = "native";
  }

  return { identifiers, identifierSources: sources, shape };
}

/**
 * Shape of an `amazon_amazon_fulfilled_inventory` row as projected by the
 * orchestrator. Identifier triad (`seller_sku`, `fulfillment_channel_sku`,
 * `asin`) is native on this table; UPC falls back to `raw_data` keys when
 * present; this table is Convention A so we project the resolver columns so
 * the orchestrator can set `rowAlreadyResolved=true` when populated.
 */
export type AmazonAmazonFulfilledInventoryRowProjection = {
  id: string;
  organization_id: string | null;
  store_id: string | null;
  seller_sku: string | null;
  fulfillment_channel_sku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  source_upload_id: string | null;
  raw_data: unknown;
};

/**
 * `amazon_amazon_fulfilled_inventory` has native seller_sku, fulfillment_channel_sku
 * (FNSKU), and asin. Title is absent on this table. UPC, if present, lives in
 * raw_data under the same key set as the Amazon listing report.
 */
export function extractFromAmazonAmazonFulfilledInventoryRow(
  row: AmazonAmazonFulfilledInventoryRowProjection,
): ExtractedIdentifiers {
  const identifiers: IdentifierMap = {};
  const sources: IdentifierSource = {};
  const shape: ShapeValidationResult = {
    seller_sku: "absent",
    asin: "absent",
    fnsku: "absent",
    upc: "absent",
    listing_id: "absent",
  };

  const sellerSku = normalizeSellerSku(row.seller_sku);
  if (sellerSku.value) {
    identifiers.seller_sku = sellerSku.value;
    sources.seller_sku = "native";
  }
  shape.seller_sku = sellerSku.shape;

  const asin = normalizeAsin(row.asin);
  if (asin.value) {
    identifiers.asin = asin.value;
    sources.asin = "native";
  }
  shape.asin = asin.shape;

  const fnsku = normalizeFnsku(row.fulfillment_channel_sku);
  if (fnsku.value) {
    identifiers.fnsku = fnsku.value;
    sources.fnsku = "native";
  }
  shape.fnsku = fnsku.shape;

  const upcRaw = rawPayloadString(row.raw_data, "upc", "upc-code", "upc_code", "UPC", "gtin", "GTIN");
  const upc = normalizeUpc(upcRaw);
  if (upc.value && upc.shape === "valid") {
    identifiers.upc = upc.value;
    sources.upc = "raw_data";
  } else if (upc.shape === "invalid") {
    identifiers.upc = upc.value;
    sources.upc = "raw_data";
  }
  shape.upc = upc.shape;

  return { identifiers, identifierSources: sources, shape };
}

/**
 * Shape of an `amazon_manage_fba_inventory` row as projected by the orchestrator.
 * Convention A (resolved_product_id + resolved_catalog_product_id present). The
 * identifier triad lives in slightly differently-named native columns than
 * `amazon_amazon_fulfilled_inventory` (`sku` instead of `seller_sku`, `fnsku`
 * instead of `fulfillment_channel_sku`), and this is the first wired table
 * with a native `product_name` column flowing into `identifiers.title`.
 */
export type AmazonManageFbaInventoryRowProjection = {
  id: string;
  organization_id: string | null;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_name: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  source_upload_id: string | null;
  raw_data: unknown;
};

/**
 * `amazon_manage_fba_inventory` has native sku, fnsku, asin, and product_name.
 * UPC, if present, lives in raw_data under the same key set used elsewhere.
 */
export function extractFromAmazonManageFbaInventoryRow(
  row: AmazonManageFbaInventoryRowProjection,
): ExtractedIdentifiers {
  const identifiers: IdentifierMap = {};
  const sources: IdentifierSource = {};
  const shape: ShapeValidationResult = {
    seller_sku: "absent",
    asin: "absent",
    fnsku: "absent",
    upc: "absent",
    listing_id: "absent",
  };

  const sellerSku = normalizeSellerSku(row.sku);
  if (sellerSku.value) {
    identifiers.seller_sku = sellerSku.value;
    sources.seller_sku = "native";
  }
  shape.seller_sku = sellerSku.shape;

  const asin = normalizeAsin(row.asin);
  if (asin.value) {
    identifiers.asin = asin.value;
    sources.asin = "native";
  }
  shape.asin = asin.shape;

  const fnsku = normalizeFnsku(row.fnsku);
  if (fnsku.value) {
    identifiers.fnsku = fnsku.value;
    sources.fnsku = "native";
  }
  shape.fnsku = fnsku.shape;

  const upcRaw = rawPayloadString(row.raw_data, "upc", "upc-code", "upc_code", "UPC", "gtin", "GTIN");
  const upc = normalizeUpc(upcRaw);
  if (upc.value && upc.shape === "valid") {
    identifiers.upc = upc.value;
    sources.upc = "raw_data";
  } else if (upc.shape === "invalid") {
    identifiers.upc = upc.value;
    sources.upc = "raw_data";
  }
  shape.upc = upc.shape;

  const title = normalizeTitle(row.product_name);
  if (title) {
    identifiers.title = title;
    sources.title = "native";
  }

  return { identifiers, identifierSources: sources, shape };
}

/**
 * Shape of an `amazon_fba_inventory` row as projected by the orchestrator.
 * Resolver UUIDs are optional: present after migration `20260813120000_amazon_fba_inventory_resolver_columns`
 * and when the resolver pipeline has populated them. The identifier triad
 * (sku/fnsku/asin) is native, plus a native `product_name` flowing into
 * `identifiers.title`. UPC, if present, uses the same `raw_data` key set as
 * the other FBA tables.
 */
export type AmazonFbaInventoryRowProjection = {
  id: string;
  organization_id: string | null;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_name: string | null;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  source_upload_id: string | null;
  raw_data: unknown;
};

/**
 * `amazon_fba_inventory` (Inventory Health) — identifier extraction.
 *
 * Mirrors `extractFromAmazonManageFbaInventoryRow` for native identifiers.
 * When `resolved_product_id` / `resolved_catalog_product_id` are non-null on
 * the row, the dry-run descriptor passes them into the classifier as
 * Convention A/B “already resolved” inputs (see `SourceTableDescriptor`).
 */
export function extractFromAmazonFbaInventoryRow(
  row: AmazonFbaInventoryRowProjection,
): ExtractedIdentifiers {
  const identifiers: IdentifierMap = {};
  const sources: IdentifierSource = {};
  const shape: ShapeValidationResult = {
    seller_sku: "absent",
    asin: "absent",
    fnsku: "absent",
    upc: "absent",
    listing_id: "absent",
  };

  const sellerSku = normalizeSellerSku(row.sku);
  if (sellerSku.value) {
    identifiers.seller_sku = sellerSku.value;
    sources.seller_sku = "native";
  }
  shape.seller_sku = sellerSku.shape;

  const asin = normalizeAsin(row.asin);
  if (asin.value) {
    identifiers.asin = asin.value;
    sources.asin = "native";
  }
  shape.asin = asin.shape;

  const fnsku = normalizeFnsku(row.fnsku);
  if (fnsku.value) {
    identifiers.fnsku = fnsku.value;
    sources.fnsku = "native";
  }
  shape.fnsku = fnsku.shape;

  const upcRaw = rawPayloadString(row.raw_data, "upc", "upc-code", "upc_code", "UPC", "gtin", "GTIN");
  const upc = normalizeUpc(upcRaw);
  if (upc.value && upc.shape === "valid") {
    identifiers.upc = upc.value;
    sources.upc = "raw_data";
  } else if (upc.shape === "invalid") {
    identifiers.upc = upc.value;
    sources.upc = "raw_data";
  }
  shape.upc = upc.shape;

  const title = normalizeTitle(row.product_name);
  if (title) {
    identifiers.title = title;
    sources.title = "native";
  }

  return { identifiers, identifierSources: sources, shape };
}

/**
 * Stub for the source tables NOT wired in this slice. The orchestrator must
 * reject any --source-table value that lands here so the operator gets a clear
 * "not yet implemented" error rather than a silently incomplete audit.
 */
export function extractNotImplemented(table: string): never {
  throw new Error(
    `[product-seed-audit] source table "${table}" is not wired yet. ` +
      `This slice supports --source-table=catalog_products, ` +
      `--source-table=amazon_amazon_fulfilled_inventory, ` +
      `--source-table=amazon_manage_fba_inventory, and ` +
      `--source-table=amazon_fba_inventory. ` +
      `See NEXT-18B plan section N for the staged-implementation order.`,
  );
}
