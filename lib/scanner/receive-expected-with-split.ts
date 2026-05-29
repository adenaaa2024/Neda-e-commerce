import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuidString } from "@/lib/uuid";

export type AllocateReturnItemsResult = {
  return_item_id: string;
  allocated_expected_package_id: string | null;
  parent_expected_package_id: string | null;
  product_match_status: string | null;
  error_message: string | null;
};

export function buildReceiveScopeKey(parts: {
  organizationId: string;
  storeId: string;
  packageId: string | null;
  slipCode: string | null;
  entityType?: string | null;
}): string {
  return [
    parts.organizationId,
    parts.storeId,
    parts.packageId ?? "",
    parts.slipCode ?? "",
    parts.entityType ?? "package",
  ].join("|");
}

export async function fetchPackageReceiveContext(
  supabase: SupabaseClient,
  packageId: string | null,
): Promise<{ slipCode: string | null; trackingNumber: string | null; palletId: string | null }> {
  if (!packageId || !isUuidString(packageId)) {
    return { slipCode: null, trackingNumber: null, palletId: null };
  }
  const { data } = await supabase
    .from("packages")
    .select("id_slip_contents, tracking_number, pallet_id")
    .eq("id", packageId)
    .maybeSingle();
  const row = data as {
    id_slip_contents?: string | null;
    tracking_number?: string | null;
    pallet_id?: string | null;
  } | null;
  return {
    slipCode: row?.id_slip_contents?.trim() || null,
    trackingNumber: row?.tracking_number?.trim() || null,
    palletId: row?.pallet_id?.trim() || null,
  };
}

/** Batch allocate one expected unit per return_items row (item-level receive). */
export async function allocateExpectedItemsForReturnItemIds(
  supabase: SupabaseClient,
  input: {
    returnItemIds: string[];
    expectedPackageHintId?: string | null;
    receiveScopeKey?: string | null;
  },
): Promise<{ ok: true; rows: AllocateReturnItemsResult[] } | { ok: false; error: string; rows: AllocateReturnItemsResult[] }> {
  const ids = [...new Set(input.returnItemIds.map((id) => id.trim()).filter((id) => isUuidString(id)))];
  if (!ids.length) {
    return { ok: false, error: "No valid return_item ids.", rows: [] };
  }

  const hint = input.expectedPackageHintId?.trim();
  const { data, error } = await supabase.rpc("allocate_expected_items_for_return_item_ids", {
    p_return_item_ids: ids,
    p_expected_package_hint: hint && isUuidString(hint) ? hint : null,
    p_receive_scope_key: input.receiveScopeKey?.trim() || null,
  });

  if (error) {
    return { ok: false, error: error.message, rows: [] };
  }

  const rows: AllocateReturnItemsResult[] = (Array.isArray(data) ? data : []).map((r) => {
    const rec = r as Record<string, unknown>;
    return {
      return_item_id: String(rec.return_item_id ?? ""),
      allocated_expected_package_id: rec.allocated_expected_package_id
        ? String(rec.allocated_expected_package_id)
        : null,
      parent_expected_package_id: rec.parent_expected_package_id
        ? String(rec.parent_expected_package_id)
        : null,
      product_match_status: rec.product_match_status != null ? String(rec.product_match_status) : null,
      error_message: rec.error_message != null ? String(rec.error_message) : null,
    };
  });

  const failed = rows.find((r) => r.error_message);
  if (failed) {
    return {
      ok: false,
      error: failed.error_message ?? "Allocation failed for one or more return items.",
      rows,
    };
  }

  return { ok: true, rows };
}
