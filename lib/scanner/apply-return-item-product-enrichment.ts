import type { SupabaseClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE } from "@/app/returns/returns-constants";
import { isUuidString, uuidOrNull } from "@/lib/uuid";
import { resolveProductForScannerItem } from "./resolve-product-for-scanner-item";
import { updateRowWithScannerLinkagePatch } from "./scanner-linkage-patch";

/**
 * Post-insert enrichment for `return_items`: never throws; logs and skips on schema drift.
 */
export async function applyReturnItemProductEnrichmentAfterInsert(
  supabase: SupabaseClient,
  params: {
    returnItemId: string;
    organizationId: string;
    storeId: string | null;
    asin?: string | null;
    fnsku?: string | null;
    sku?: string | null;
    /** `expected_packages.id` for resolver context (not written to `return_items`). */
    expectedPackageId?: string | null;
    /** @deprecated Use `expectedPackageId`. */
    expectedItemId?: string | null;
    actorProfileId?: string | null;
  },
): Promise<void> {
  const rid = String(params.returnItemId ?? "").trim();
  if (!isUuidString(rid)) return;

  try {
    const epHint = uuidOrNull(params.expectedPackageId ?? params.expectedItemId ?? null);
    const res = await resolveProductForScannerItem(supabase, {
      organization_id: params.organizationId,
      store_id: params.storeId,
      expected_package_id: epHint,
      asin: params.asin,
      fnsku: params.fnsku,
      sku: params.sku,
      source_table: RETURN_ITEMS_TABLE,
      source_row_id: rid,
    });

    const patch: Record<string, unknown> = {
      resolved_product_id: res.resolved_product_id,
      resolved_catalog_product_id: res.resolved_catalog_product_id,
      identifier_resolution_status: res.status,
      identifier_resolution_confidence: res.confidence,
      identifier_resolution_source: res.matched_via,
    };

    const { error } = await updateRowWithScannerLinkagePatch(supabase, RETURN_ITEMS_TABLE, rid, patch);
    if (error) {
      console.warn("[applyReturnItemProductEnrichmentAfterInsert]", error.message);
    }
  } catch (e) {
    console.warn("[applyReturnItemProductEnrichmentAfterInsert] skipped:", e);
  }
}
