/**
 * Unified operational product linkage resolver — all paths converge here.
 * Never creates products. Never writes to DB.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveProductIdentifierMapMatch } from "./amazon-operational-product-resolve";
import { mapRowToProductLinkageDisplayContract } from "./product-linkage-display-contract";
import type { ProductLinkageDisplayContract } from "./product-linkage-display-contract";
import { normalizeOperationalIdentifiers } from "./product-linkage-identifier-normalize";
import {
  type OperationalLinkagePath,
  type ProductLinkageResolutionContext,
  RESOLUTION_ORDER_OPERATIONAL,
  RESOLUTION_ORDER_SCANNER,
  computeProductLinkageConfidence,
  confidenceFromMatchTier,
  formatResolutionOrderExport,
} from "./product-linkage-resolution-policy";
import { resolveScannerProductIdentifiers } from "./scanner-product-resolve";

export type OperationalProductLinkageResult = {
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
  matched_via: string | null;
  resolution_context: ProductLinkageResolutionContext;
  operational_path: OperationalLinkagePath;
  resolution_order: readonly string[];
  display_contract: ProductLinkageDisplayContract;
};

export type ResolveOperationalProductLinkageInput = {
  organizationId: string;
  storeId?: string | null;
  source_table: string;
  source_row_id: string;
  operational_path: OperationalLinkagePath;
  /** Scanner contexts use barcode-first order; imports use FNSKU-first. */
  resolution_context?: ProductLinkageResolutionContext;
  row: Record<string, unknown>;
  legacyProductId?: string | null;
};

function inferResolutionContext(
  path: OperationalLinkagePath,
  explicit?: ProductLinkageResolutionContext,
): ProductLinkageResolutionContext {
  if (explicit) return explicit;
  if (path === "scan") return "scanner";
  if (path === "expected" || path === "shipment" || path === "removal") return "read_model";
  return "operational_import";
}

/**
 * Resolve one operational row to canonical product linkage columns + display contract.
 */
export async function resolveOperationalProductLinkage(
  supabase: SupabaseClient,
  input: ResolveOperationalProductLinkageInput,
): Promise<OperationalProductLinkageResult> {
  const ids = normalizeOperationalIdentifiers(input.row);
  const context = inferResolutionContext(input.operational_path, input.resolution_context);
  const order =
    context === "scanner" ? RESOLUTION_ORDER_SCANNER : RESOLUTION_ORDER_OPERATIONAL;

  const baseContract = mapRowToProductLinkageDisplayContract({
    source_table: input.source_table,
    source_row_id: input.source_row_id,
    row: {
      ...input.row,
      asin: ids.asin ?? input.row.asin,
      fnsku: ids.fnsku ?? input.row.fnsku,
      sku: ids.sku ?? input.row.sku,
      upc: ids.upc ?? input.row.upc,
    },
  });

  if (context === "scanner" || context === "read_model") {
    const scanner = await resolveScannerProductIdentifiers(supabase, {
      organizationId: input.organizationId,
      storeId: input.storeId,
      sku: ids.sku,
      asin: ids.asin,
      fnsku: ids.fnsku,
      upc: ids.upc,
      gtin: ids.barcodeVariants[1] ?? null,
      legacyProductId: input.legacyProductId ?? null,
    });

    const status = scanner.identifier_resolution_status ?? "unresolved";
    const confidence = computeProductLinkageConfidence({
      status: status === "mismatch" ? "mismatch" : (status as "resolved" | "ambiguous" | "unresolved"),
      baseConfidence: scanner.identifier_resolution_confidence ?? 0,
      matchedVia: scanner.resolved_product_id ? "scanner_resolution" : "none",
    });

    const contract = mapRowToProductLinkageDisplayContract({
      source_table: input.source_table,
      source_row_id: input.source_row_id,
      row: {
        ...input.row,
        asin: ids.asin,
        fnsku: ids.fnsku,
        sku: ids.sku,
        upc: ids.upc,
        resolved_product_id: scanner.resolved_product_id,
        resolved_catalog_product_id: scanner.resolved_catalog_product_id,
        identifier_resolution_status: scanner.identifier_resolution_status,
        identifier_resolution_confidence: confidence,
      },
    });

    return {
      resolved_product_id: scanner.resolved_product_id,
      resolved_catalog_product_id: scanner.resolved_catalog_product_id,
      identifier_resolution_status: scanner.identifier_resolution_status,
      identifier_resolution_confidence: confidence,
      matched_via: scanner.resolved_product_id ? formatResolutionOrderExport("scanner") : null,
      resolution_context: context,
      operational_path: input.operational_path,
      resolution_order: order,
      display_contract: contract,
    };
  }

  const storeId = input.storeId;
  if (!storeId) {
    return {
      resolved_product_id: null,
      resolved_catalog_product_id: null,
      identifier_resolution_status: "unresolved",
      identifier_resolution_confidence: null,
      matched_via: null,
      resolution_context: context,
      operational_path: input.operational_path,
      resolution_order: order,
      display_contract: baseContract,
    };
  }

  const match = await resolveProductIdentifierMapMatch(supabase, {
    organizationId: input.organizationId,
    storeId,
    fnsku: ids.fnsku,
    msku: ids.sku,
    sku: ids.sku,
    asin: ids.asin,
    upc: ids.upc,
    gtin: ids.barcodeVariants[1] ?? null,
  });

  const tierConf = match.tier != null ? confidenceFromMatchTier(match.tier) : 0;
  const mapConf = match.row?.confidence_score ?? null;
  const confidence = computeProductLinkageConfidence({
    status: match.status,
    baseConfidence: tierConf,
    mapConfidenceScore: mapConf,
    matchedVia: match.row?.match_source ?? "operational_map_match",
  });

  const resolvedId = match.status === "resolved" ? match.row?.product_id ?? null : null;
  const contract = mapRowToProductLinkageDisplayContract({
    source_table: input.source_table,
    source_row_id: input.source_row_id,
    row: {
      ...input.row,
      asin: ids.asin,
      fnsku: ids.fnsku,
      sku: ids.sku,
      upc: ids.upc,
      resolved_product_id: resolvedId,
      identifier_resolution_status: match.status,
      identifier_resolution_confidence: confidence,
    },
  });

  return {
    resolved_product_id: resolvedId,
    resolved_catalog_product_id: match.row?.catalog_product_id ?? null,
    identifier_resolution_status: match.status,
    identifier_resolution_confidence: confidence,
    matched_via: match.tier != null ? `tier_${match.tier}` : null,
    resolution_context: context,
    operational_path: input.operational_path,
    resolution_order: order,
    display_contract: contract,
  };
}

export {
  RESOLUTION_ORDER_SCANNER,
  RESOLUTION_ORDER_OPERATIONAL,
  formatResolutionOrderExport,
};
