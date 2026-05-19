import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuidString } from "@/lib/uuid";
import { resolveProductForScannerItem } from "./resolve-product-for-scanner-item";
import { updateRowWithScannerLinkagePatch } from "./scanner-linkage-patch";

export type SlipLineForEnrichment = {
  sort_index: number;
  upc: string | null;
  fnsku: string | null;
  description: string | null;
};

/**
 * After `slip_contents` bulk insert, best-effort deterministic resolution per row.
 */
export async function enrichSlipContentsProductLinksAfterReplace(
  supabase: SupabaseClient,
  params: {
    packageId: string;
    organizationId: string;
    storeId: string | null;
    lines: SlipLineForEnrichment[];
  },
): Promise<void> {
  const pkg = String(params.packageId ?? "").trim();
  if (!isUuidString(pkg) || !params.lines.length) return;

  try {
    const { data: rows, error } = await supabase
      .from("slip_contents")
      .select("id, sort_index")
      .eq("package_id", pkg)
      .eq("organization_id", params.organizationId)
      .order("sort_index", { ascending: true });
    if (error || !rows?.length) return;

    const bySort = new Map<number, string>();
    for (const r of rows as { id?: string; sort_index?: number }[]) {
      const si = Number(r.sort_index ?? 0);
      const id = String(r.id ?? "").trim();
      if (Number.isFinite(si) && isUuidString(id)) bySort.set(si, id);
    }

    for (const line of params.lines) {
      const id = bySort.get(line.sort_index);
      if (!id) continue;

      const res = await resolveProductForScannerItem(supabase, {
        organization_id: params.organizationId,
        store_id: params.storeId,
        fnsku: line.fnsku,
        upc: line.upc,
        ocr_product_name: line.description,
        source_table: "slip_contents",
        source_row_id: id,
      });

      const patch: Record<string, unknown> = {
        resolved_product_id: res.resolved_product_id,
        resolved_catalog_product_id: res.resolved_catalog_product_id,
        identifier_resolution_status: res.status,
        identifier_resolution_confidence: res.confidence,
        identifier_resolution_source: res.matched_via,
      };

      const { error: upErr } = await updateRowWithScannerLinkagePatch(supabase, "slip_contents", id, patch);
      if (upErr) {
        console.warn("[enrichSlipContentsProductLinksAfterReplace]", upErr.message, { id });
      }
    }
  } catch (e) {
    console.warn("[enrichSlipContentsProductLinksAfterReplace] skipped:", e);
  }
}
