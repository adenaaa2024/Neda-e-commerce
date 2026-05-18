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
    legacyProductId?: string | null;
  },
): Promise<ScannerResolutionColumns> {
  const storeId = n(args.storeId);
  const sku = n(args.sku);
  const asin = n(args.asin);
  const fnsku = n(args.fnsku);
  const hasAnyId = !!(sku || asin || fnsku);
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
    });
  } catch {
    return { ...empty, identifier_resolution_status: "unresolved" };
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
