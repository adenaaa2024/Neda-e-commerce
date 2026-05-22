/**
 * Deterministic product resolution for scanner flows (return_items, manifest lines,
 * expected_items, slip_contents). Uses `product_identifier_map` via
 * `resolveProductIdentifierMapMatch` — never fabricates a product id.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveProductIdentifierMapMatch } from "./amazon-operational-product-resolve";
import type { ExpectedItem } from "../app/returns/returns-action-types";

export type ScannerResolutionColumns = {
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
};

const empty: ScannerResolutionColumns = {
  resolved_product_id: null,
  resolved_catalog_product_id: null,
  identifier_resolution_status: null,
  identifier_resolution_confidence: null,
};

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

type ProductDirectMatch = {
  product_id: string;
  confidence: number;
} | {
  product_id: null;
  confidence: number | null;
  ambiguous: boolean;
};

async function queryProductDirectMatch(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    storeId: string;
    column: "fnsku" | "sku" | "asin" | "upc_code" | "barcode";
    value: string;
    asin?: string | null;
  },
): Promise<{ ids: string[] }> {
  let q = supabase
    .from("products")
    .select("id")
    .eq("organization_id", args.organizationId)
    .eq("store_id", args.storeId)
    .eq(args.column, args.value)
    .limit(10);

  if (args.asin) q = q.eq("asin", args.asin);

  const { data, error } = await q;
  if (error) return { ids: [] };
  return {
    ids: [
      ...new Set(
        (data ?? [])
          .map((r) => n((r as { id?: unknown }).id))
          .filter((x): x is string => !!x),
      ),
    ],
  };
}

async function resolveProductsDirectMatch(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    storeId: string;
    sku?: string | null;
    asin?: string | null;
    fnsku?: string | null;
    upc?: string | null;
  },
): Promise<ProductDirectMatch> {
  const checks: { column: "fnsku" | "sku" | "asin" | "upc_code" | "barcode"; value: string; asin?: string | null; confidence: number }[] = [];
  if (args.fnsku) checks.push({ column: "fnsku", value: args.fnsku, confidence: 1 });
  if (args.sku && args.asin) checks.push({ column: "sku", value: args.sku, asin: args.asin, confidence: 0.95 });
  if (args.asin) checks.push({ column: "asin", value: args.asin, confidence: 0.7 });
  if (args.sku) checks.push({ column: "sku", value: args.sku, confidence: 0.85 });
  if (args.upc) {
    checks.push({ column: "upc_code", value: args.upc, confidence: 0.9 });
    checks.push({ column: "barcode", value: args.upc, confidence: 0.9 });
  }

  for (const check of checks) {
    const { ids } = await queryProductDirectMatch(supabase, {
      organizationId: args.organizationId,
      storeId: args.storeId,
      column: check.column,
      value: check.value,
      asin: check.asin,
    });
    if (ids.length === 1) return { product_id: ids[0]!, confidence: check.confidence };
    if (ids.length > 1) return { product_id: null, confidence: check.confidence, ambiguous: true };
  }

  return { product_id: null, confidence: null, ambiguous: false };
}

/**
 * Build nullable resolver columns for a single identifier bundle (org + store scoped).
 * When `legacyProductId` is set and disagrees with a resolved `product_id`, status is `mismatch`
 * and resolved ids are cleared so operators must review.
 */
export async function resolveScannerProductIdentifiers(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    storeId?: string | null;
    sku?: string | null;
    asin?: string | null;
    fnsku?: string | null;
    upc?: string | null;
    gtin?: string | null;
    productIdentifier?: string | null;
    legacyProductId?: string | null;
  },
): Promise<ScannerResolutionColumns> {
  const storeId = n(args.storeId);
  const sku = n(args.sku);
  const asin = n(args.asin);
  const fnsku = n(args.fnsku);
  const upc = n(args.upc) ?? n(args.gtin) ?? n(args.productIdentifier);
  const hasAnyId = !!(sku || asin || fnsku || upc);
  if (!hasAnyId) {
    return { ...empty, identifier_resolution_status: "unresolved" };
  }
  if (!storeId) {
    return { ...empty, identifier_resolution_status: "unresolved" };
  }

  let match;
  try {
    match = await resolveProductIdentifierMapMatch(supabase, {
      organizationId: args.organizationId,
      storeId,
      msku: sku,
      asin,
      fnsku,
      upc,
    });
  } catch {
    match = { row: null, status: "unresolved" as const, tier: null, confidence: 0, candidatesConsidered: 0 };
  }

  const legacy = n(args.legacyProductId);

  if (match.status === "ambiguous") {
    return {
      ...empty,
      identifier_resolution_status: "ambiguous",
      identifier_resolution_confidence: match.confidence,
    };
  }
  if (match.status === "unresolved" || !match.row) {
    const direct = await resolveProductsDirectMatch(supabase, {
      organizationId: args.organizationId,
      storeId,
      sku,
      asin,
      fnsku,
      upc,
    });
    if (direct.product_id) {
      return {
        resolved_product_id: direct.product_id,
        resolved_catalog_product_id: null,
        identifier_resolution_status: "resolved",
        identifier_resolution_confidence: direct.confidence,
      };
    }
    if ("ambiguous" in direct && direct.ambiguous) {
      return {
        ...empty,
        identifier_resolution_status: "ambiguous",
        identifier_resolution_confidence: direct.confidence,
      };
    }
    return {
      ...empty,
      identifier_resolution_status: "unresolved",
      identifier_resolution_confidence:
        match.candidatesConsidered > 0 ? match.confidence : null,
    };
  }

  const pid = n(match.row.product_id);
  const cpid = n(match.row.catalog_product_id);
  if (legacy && pid && legacy !== pid) {
    return {
      resolved_product_id: null,
      resolved_catalog_product_id: null,
      identifier_resolution_status: "mismatch",
      identifier_resolution_confidence: match.confidence,
    };
  }

  return {
    resolved_product_id: pid,
    resolved_catalog_product_id: cpid,
    identifier_resolution_status: "resolved",
    identifier_resolution_confidence: match.confidence,
  };
}

/** Enrich packing-slip / manifest expected lines in-memory (JSON persisted on package). */
export async function enrichExpectedItemsProductResolution(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string | null | undefined,
  lines: ExpectedItem[] | null | undefined,
): Promise<ExpectedItem[] | null | undefined> {
  if (!lines?.length) return lines;
  const out: ExpectedItem[] = [];
  for (const line of lines) {
    const res = await resolveScannerProductIdentifiers(supabase, {
      organizationId,
      storeId,
      sku: line.sku,
      asin: line.asin,
      fnsku: line.fnsku,
    });
    out.push({
      ...line,
      resolved_product_id: res.resolved_product_id,
      resolved_catalog_product_id: res.resolved_catalog_product_id,
      identifier_resolution_status: res.identifier_resolution_status,
      identifier_resolution_confidence: res.identifier_resolution_confidence,
    });
  }
  return out;
}
