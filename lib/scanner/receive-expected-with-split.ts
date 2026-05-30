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

export type ReleaseExpectedItemUnitResult = {
  released: boolean;
  parent_restored_id: string | null;
  child_archived_id: string | null;
};

/** Release one allocated expected unit for a return_items row (RPC: release_expected_item_unit). */
export async function releaseExpectedItemUnit(
  supabase: SupabaseClient,
  input: {
    returnItemId: string;
    organizationId: string;
    /** When true, RPC soft-deletes the return_items row; when false, only clears expected_item_id. */
    softDelete?: boolean;
  },
): Promise<{ ok: true; result: ReleaseExpectedItemUnitResult } | { ok: false; error: string }> {
  const returnItemId = input.returnItemId.trim();
  const organizationId = input.organizationId.trim();
  if (!isUuidString(returnItemId) || !isUuidString(organizationId)) {
    return { ok: false, error: "Invalid return_item or organization id." };
  }

  const { data, error } = await supabase.rpc("release_expected_item_unit", {
    p_return_item_id: returnItemId,
    p_organization_id: organizationId,
    p_soft_delete: input.softDelete ?? true,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  return {
    ok: true,
    result: {
      released: Boolean(row?.released),
      parent_restored_id: row?.parent_restored_id ? String(row.parent_restored_id) : null,
      child_archived_id: row?.child_archived_id ? String(row.child_archived_id) : null,
    },
  };
}

/** Release allocation for every active return_items row on a package (void/delete package path). */
export async function releaseExpectedItemsForPackage(
  supabase: SupabaseClient,
  input: {
    packageId: string;
    organizationId: string;
    softDelete?: boolean;
  },
): Promise<
  | { ok: true; releasedCount: number; results: Array<{ returnItemId: string; released: boolean }> }
  | { ok: false; error: string }
> {
  const packageId = input.packageId.trim();
  const organizationId = input.organizationId.trim();
  if (!isUuidString(packageId) || !isUuidString(organizationId)) {
    return { ok: false, error: "Invalid package or organization id." };
  }

  const { data: rows, error: listErr } = await supabase
    .from("return_items")
    .select("id")
    .eq("package_id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);

  if (listErr) return { ok: false, error: listErr.message };

  const results: Array<{ returnItemId: string; released: boolean }> = [];
  let releasedCount = 0;

  for (const row of rows ?? []) {
    const returnItemId = String((row as { id?: string }).id ?? "").trim();
    if (!isUuidString(returnItemId)) continue;
    const rel = await releaseExpectedItemUnit(supabase, {
      returnItemId,
      organizationId,
      softDelete: input.softDelete ?? true,
    });
    if (!rel.ok) return { ok: false, error: rel.error };
    results.push({ returnItemId, released: rel.result.released });
    if (rel.result.released) releasedCount += 1;
  }

  return { ok: true, releasedCount, results };
}

/** Re-scope allocated units after package parent move (RPC: move_expected_item_unit per row). */
export async function moveExpectedItemsForPackageScope(
  supabase: SupabaseClient,
  input: {
    packageId: string;
    organizationId: string;
    storeId: string;
    receiveScopeKey: string;
    trackingNumber?: string | null;
  },
): Promise<{ ok: true; movedCount: number } | { ok: false; error: string }> {
  const packageId = input.packageId.trim();
  const organizationId = input.organizationId.trim();
  const storeId = input.storeId.trim();
  if (!isUuidString(packageId) || !isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "Invalid package, organization, or store id." };
  }

  const { data: rows, error: listErr } = await supabase
    .from("return_items")
    .select("id, expected_item_id, order_id, resolved_product_id")
    .eq("package_id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .not("expected_item_id", "is", null);

  if (listErr) return { ok: false, error: listErr.message };

  let movedCount = 0;
  for (const row of rows ?? []) {
    const rec = row as {
      id?: string;
      expected_item_id?: string | null;
      order_id?: string | null;
      resolved_product_id?: string | null;
    };
    const returnItemId = String(rec.id ?? "").trim();
    if (!isUuidString(returnItemId) || !rec.expected_item_id) continue;

    const { error } = await supabase.rpc("move_expected_item_unit", {
      p_return_item_id: returnItemId,
      p_organization_id: organizationId,
      p_store_id: storeId,
      p_new_package_id: packageId,
      p_new_receive_scope_key: input.receiveScopeKey.trim(),
      p_new_order_id: rec.order_id?.trim() || null,
      p_new_tracking_number: input.trackingNumber?.trim() || null,
      p_new_resolved_product_id: rec.resolved_product_id?.trim() || null,
    });
    if (error) return { ok: false, error: error.message };
    movedCount += 1;
  }

  return { ok: true, movedCount };
}

/** Soft-void one return_items row: release allocation (no RPC row delete), then set deleted_at. */
export async function softVoidReturnItemWithExpectedRelease(
  supabase: SupabaseClient,
  input: {
    returnItemId: string;
    organizationId: string;
    updatedBy?: string | null;
  },
): Promise<{ ok: true; released: boolean } | { ok: false; error: string }> {
  const returnItemId = input.returnItemId.trim();
  const organizationId = input.organizationId.trim();
  if (!isUuidString(returnItemId) || !isUuidString(organizationId)) {
    return { ok: false, error: "Invalid return_item or organization id." };
  }

  const { data: existing, error: loadErr } = await supabase
    .from("return_items")
    .select("id, deleted_at")
    .eq("id", returnItemId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!existing) return { ok: false, error: "Return item not found." };
  if ((existing as { deleted_at?: string | null }).deleted_at) {
    return { ok: true, released: false };
  }

  const release = await releaseExpectedItemUnit(supabase, {
    returnItemId,
    organizationId,
    softDelete: false,
  });
  if (!release.ok) return { ok: false, error: release.error };

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { deleted_at: now, updated_at: now };
  if (input.updatedBy && isUuidString(input.updatedBy)) patch.updated_by = input.updatedBy;

  const { error: upErr } = await supabase
    .from("return_items")
    .update(patch)
    .eq("id", returnItemId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  if (upErr) return { ok: false, error: upErr.message };

  return { ok: true, released: release.result.released };
}

/** Soft-void a package: release expected units for active return_items, then set packages.deleted_at. */
export async function softVoidPackageWithExpectedRelease(
  supabase: SupabaseClient,
  input: {
    packageId: string;
    organizationId: string;
    updatedBy?: string | null;
  },
): Promise<{ ok: true; releasedCount: number } | { ok: false; error: string }> {
  const packageId = input.packageId.trim();
  const organizationId = input.organizationId.trim();
  if (!isUuidString(packageId) || !isUuidString(organizationId)) {
    return { ok: false, error: "Invalid package or organization id." };
  }

  const { data: pkgRow, error: pkgErr } = await supabase
    .from("packages")
    .select("id, deleted_at")
    .eq("id", packageId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (pkgErr) return { ok: false, error: pkgErr.message };
  if (!pkgRow) return { ok: false, error: "Package not found." };
  if ((pkgRow as { deleted_at?: string | null }).deleted_at) {
    return { ok: true, releasedCount: 0 };
  }

  const releaseAlloc = await releaseExpectedItemsForPackage(supabase, {
    packageId,
    organizationId,
    softDelete: true,
  });
  if (!releaseAlloc.ok) return { ok: false, error: releaseAlloc.error };

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { deleted_at: now, updated_at: now };
  if (input.updatedBy && isUuidString(input.updatedBy)) patch.updated_by = input.updatedBy;

  const { error: upErr } = await supabase.from("packages").update(patch).eq("id", packageId);
  if (upErr) return { ok: false, error: upErr.message };

  const { error: riVoidErr } = await supabase
    .from("return_items")
    .update(patch)
    .eq("package_id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  if (riVoidErr) return { ok: false, error: riVoidErr.message };

  return { ok: true, releasedCount: releaseAlloc.releasedCount };
}

/** Soft-void a pallet and all active packages / orphan return_items on it. */
export async function softVoidPalletWithExpectedRelease(
  supabase: SupabaseClient,
  input: {
    palletId: string;
    organizationId: string;
    updatedBy?: string | null;
  },
): Promise<
  | { ok: true; packagesVoided: number; itemsVoided: number; releasedCount: number }
  | { ok: false; error: string }
> {
  const palletId = input.palletId.trim();
  const organizationId = input.organizationId.trim();
  if (!isUuidString(palletId) || !isUuidString(organizationId)) {
    return { ok: false, error: "Invalid pallet or organization id." };
  }

  const { data: palRow, error: palErr } = await supabase
    .from("pallets")
    .select("id, deleted_at")
    .eq("id", palletId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (palErr) return { ok: false, error: palErr.message };
  if (!palRow) return { ok: false, error: "Pallet not found." };
  if ((palRow as { deleted_at?: string | null }).deleted_at) {
    return { ok: true, packagesVoided: 0, itemsVoided: 0, releasedCount: 0 };
  }

  let packagesVoided = 0;
  let releasedCount = 0;

  const { data: pkgRows, error: listPkgErr } = await supabase
    .from("packages")
    .select("id")
    .eq("pallet_id", palletId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  if (listPkgErr) return { ok: false, error: listPkgErr.message };

  for (const row of pkgRows ?? []) {
    const pkgId = String((row as { id?: string }).id ?? "").trim();
    if (!isUuidString(pkgId)) continue;
    const voided = await softVoidPackageWithExpectedRelease(supabase, {
      packageId: pkgId,
      organizationId,
      updatedBy: input.updatedBy,
    });
    if (!voided.ok) return { ok: false, error: voided.error };
    packagesVoided += 1;
    releasedCount += voided.releasedCount;
  }

  let itemsVoided = 0;
  const { data: orphanRows, error: listRiErr } = await supabase
    .from("return_items")
    .select("id")
    .eq("pallet_id", palletId)
    .eq("organization_id", organizationId)
    .is("package_id", null)
    .is("deleted_at", null);
  if (listRiErr) return { ok: false, error: listRiErr.message };

  for (const row of orphanRows ?? []) {
    const rid = String((row as { id?: string }).id ?? "").trim();
    if (!isUuidString(rid)) continue;
    const voided = await softVoidReturnItemWithExpectedRelease(supabase, {
      returnItemId: rid,
      organizationId,
      updatedBy: input.updatedBy,
    });
    if (!voided.ok) return { ok: false, error: voided.error };
    itemsVoided += 1;
    if (voided.released) releasedCount += 1;
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { deleted_at: now, updated_at: now };
  if (input.updatedBy && isUuidString(input.updatedBy)) patch.updated_by = input.updatedBy;

  const { error: upErr } = await supabase.from("pallets").update(patch).eq("id", palletId);
  if (upErr) return { ok: false, error: upErr.message };

  return { ok: true, packagesVoided, itemsVoided, releasedCount };
}
