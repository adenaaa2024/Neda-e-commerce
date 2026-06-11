/**
 * Canonical product linkage resolution policy — single source of truth for
 * deterministic identifier order, confidence scoring, and path classification.
 *
 * Does NOT create products. Does NOT write to DB.
 */

import type { IdentifierMatchTier } from "./product-identifier-match";

/** Scanner / warehouse barcode-first contexts (return_items, slip scan). */
export const RESOLUTION_ORDER_SCANNER = [
  "upc_ean_gtin",
  "sku_msku",
  "fnsku",
  "asin",
] as const;

/**
 * Operational import / Amazon report contexts (FNSKU-first per governance V192).
 * Sub-rank: ASIN+SKU pair beats ASIN-only; SKU+ASIN beats SKU-only.
 */
export const RESOLUTION_ORDER_OPERATIONAL = [
  "fnsku",
  "asin_with_sku",
  "asin",
  "sku_msku",
  "upc_ean_gtin",
] as const;

export type ProductLinkageResolutionContext =
  | "scanner"
  | "operational_import"
  | "read_model";

export type OperationalLinkagePath =
  | "scan"
  | "expected"
  | "shipment"
  | "removal"
  | "claim"
  | "reference"
  | "inventory";

export type ResolutionOrderStep = (typeof RESOLUTION_ORDER_SCANNER)[number];

export function resolutionOrderForContext(
  context: ProductLinkageResolutionContext,
): readonly string[] {
  return context === "scanner" ? RESOLUTION_ORDER_SCANNER : RESOLUTION_ORDER_OPERATIONAL;
}

/** Map matcher tier → base confidence (operational import path). */
export function confidenceFromMatchTier(tier: IdentifierMatchTier): number {
  switch (tier) {
    case 1:
      return 1;
    case 2:
      return 0.95;
    case 3:
      return 0.85;
    case 4:
      return 0.9;
    default:
      return 0.65;
  }
}

/** Scanner path confidence by matched_via key (Phase 10 resolver). */
export const SCANNER_MATCH_CONFIDENCE: Record<string, number> = {
  "product_identifier_map.upc": 0.9,
  "products.upc_code": 0.85,
  "products.barcode": 0.85,
  "product_identifier_map.seller_sku": 0.9,
  "product_identifier_map.msku": 0.88,
  "products.sku": 0.85,
  "product_identifier_map.fnsku": 0.95,
  "products.fnsku": 0.9,
  "product_identifier_map.asin": 0.8,
  "products.asin": 0.75,
  none: 0,
};

export type LinkageConfidenceInput = {
  status: "resolved" | "ambiguous" | "unresolved" | "mismatch";
  baseConfidence: number;
  /** Existing map row confidence_score when present. */
  mapConfidenceScore?: number | null;
  matchedVia?: string | null;
};

/**
 * Final product linkage confidence score in [0, 1].
 * Uses max(map provenance, tier/base) when resolved; dampens ambiguous.
 */
export function computeProductLinkageConfidence(input: LinkageConfidenceInput): number {
  const mapScore =
    typeof input.mapConfidenceScore === "number" && Number.isFinite(input.mapConfidenceScore)
      ? Math.max(0, Math.min(1, input.mapConfidenceScore))
      : null;
  const base = Math.max(0, Math.min(1, input.baseConfidence));

  if (input.status === "mismatch") return Math.min(base, 0.35);
  if (input.status === "ambiguous") return Math.min(base, 0.45);
  if (input.status === "unresolved") return 0;

  const viaBoost =
    input.matchedVia && input.matchedVia in SCANNER_MATCH_CONFIDENCE
      ? SCANNER_MATCH_CONFIDENCE[input.matchedVia]!
      : base;
  const merged = mapScore != null ? Math.max(mapScore, base, viaBoost) : Math.max(base, viaBoost);
  return Math.round(merged * 1000) / 1000;
}

export type DuplicateRiskKind = "fnsku" | "asin" | "upc" | "sku";

export type DuplicateRiskSummary = {
  fnsku_conflict_groups: number;
  asin_conflict_groups: number;
  upc_conflict_groups: number;
  sku_conflict_groups: number;
  total_conflict_groups: number;
  safe_for_auto_map: boolean;
};

export function summarizeDuplicateRisks(counts: {
  fnsku?: number;
  asin?: number;
  upc?: number;
  sku?: number;
}): DuplicateRiskSummary {
  const fnsku = counts.fnsku ?? 0;
  const asin = counts.asin ?? 0;
  const upc = counts.upc ?? 0;
  const sku = counts.sku ?? 0;
  return {
    fnsku_conflict_groups: fnsku,
    asin_conflict_groups: asin,
    upc_conflict_groups: upc,
    sku_conflict_groups: sku,
    total_conflict_groups: fnsku + asin + upc + sku,
    safe_for_auto_map: fnsku === 0 && asin === 0,
  };
}

/** Human-readable resolution order export for audits. */
export function formatResolutionOrderExport(context: ProductLinkageResolutionContext): string {
  return resolutionOrderForContext(context).join(" → ");
}
