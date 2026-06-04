import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuidString } from "@/lib/uuid";
import {
  deletePackageCascadeV2,
  deletePalletCascadeV2,
  deleteReturnItemWithExpectedReleaseV2,
  moveReturnItemParentV2,
} from "@/lib/scanner/delete-cascade-v2-app";
import { normalizeTrackingKey } from "@/lib/scanner/tracking-normalize";

/** Same normalization as operator Item Scan slip ↔ EP matching (`slipTokenNorm`). */
export function normalizeExpectedIdentifierKey(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

export type AllocationErrorContext = {
  fnsku?: string | null;
  sku?: string | null;
  slipCode?: string | null;
  trackingNumber?: string | null;
};

/** True when RPC / allocation helper reports no open parent `expected_packages` row to receive against. */
export function isNoAllocatableExpectedAllocationError(message: string): boolean {
  return /no_allocatable_expected/i.test(String(message ?? ""));
}

export function humanizeExpectedAllocationError(
  message: string,
  ctx?: AllocationErrorContext,
): string {
  const m = String(message ?? "").trim();
  if (!m) return "Expected allocation failed.";
  if (isNoAllocatableExpectedAllocationError(m)) {
    const idParts = [
      ctx?.fnsku?.trim() ? `FNSKU ${ctx.fnsku.trim()}` : null,
      ctx?.sku?.trim() ? `SKU/UPC ${ctx.sku.trim()}` : null,
    ].filter(Boolean);
    const idLabel = idParts.length ? idParts.join(", ") : "this identifier";
    const scopeParts = [
      ctx?.slipCode?.trim() ? `slip ${ctx.slipCode.trim()}` : null,
      ctx?.trackingNumber?.trim() ? `tracking ${ctx.trackingNumber.trim()}` : null,
    ].filter(Boolean);
    const scopeLabel = scopeParts.length ? ` (${scopeParts.join("; ")})` : "";
    return `No remaining allocatable expected quantity for ${idLabel}${scopeLabel}. The packing slip may still show units, but shipment expectations have no open parent row to receive against. Sync expectations or open the matching shipment line.`;
  }
  if (/return_item_not_found/i.test(m)) return "Return item row was not found — refresh and try again.";
  return m;
}

type AllocatableEpRow = {
  id: string;
  sku: string | null;
  fnsku: string | null;
  tracking_number: string | null;
  id_slip_contents: string | null;
  expected_scan_quantity: number;
  build_source: string | null;
  order_id: string | null;
  disposition: string | null;
};

function epBuildSourceRank(buildSource: string | null): number {
  const s = String(buildSource ?? "legacy");
  if (s === "detail_remainder") return 1;
  if (s === "detail_shipment") return 2;
  return 3;
}

function epRowMatchesSlipIdentifiers(
  row: AllocatableEpRow,
  slipFnsku: string,
  slipSku: string,
): boolean {
  const f = normalizeExpectedIdentifierKey(row.fnsku);
  const sku = normalizeExpectedIdentifierKey(row.sku);
  if (slipFnsku && f && slipFnsku === f) return true;
  if (slipSku && sku && slipSku === sku) return true;
  if (slipSku && f && slipSku === f) return true;
  if (slipFnsku && sku && slipFnsku === sku) return true;
  return false;
}

function scoreAllocatableEpRow(
  row: AllocatableEpRow,
  opts: {
    slipFnsku: string;
    slipSku: string;
    normSlipCode: string;
    normTracking: string;
    orderId: string;
    disposition: string;
  },
): number {
  if (!epRowMatchesSlipIdentifiers(row, opts.slipFnsku, opts.slipSku)) return -1;
  if (String(row.build_source ?? "") === "receive_allocated") return -1;
  const remainder = Math.max(0, Math.floor(Number(row.expected_scan_quantity ?? 0)));
  if (remainder < 1) return -1;
  if (opts.orderId && String(row.order_id ?? "").trim() && String(row.order_id ?? "").trim() !== opts.orderId) {
    return -1;
  }
  if (
    opts.disposition &&
    String(row.disposition ?? "").trim() &&
    String(row.disposition ?? "").trim() !== opts.disposition
  ) {
    return -1;
  }

  let score = remainder * 10;
  const epSlip = normalizeExpectedIdentifierKey(row.id_slip_contents);
  if (opts.normSlipCode && epSlip && epSlip === opts.normSlipCode) score += 5000;
  const epTn = normalizeTrackingKey(row.tracking_number);
  if (opts.normTracking && epTn && epTn === opts.normTracking) score += 800;
  else if (!opts.normTracking) score += 200;
  else score += 50;
  score -= epBuildSourceRank(row.build_source) * 5;
  return score;
}

/**
 * Resolve a parent `expected_packages.id` with `expected_scan_quantity >= 1` using the same
 * identifier normalization as Item Scan slip rows (not package tracking alone).
 */
export async function resolveAllocatableExpectedPackageHint(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    storeId: string;
    fnsku?: string | null;
    sku?: string | null;
    upc?: string | null;
    orderId?: string | null;
    disposition?: string | null;
    packageSlipCode?: string | null;
    packageTrackingNumber?: string | null;
    preferredHintId?: string | null;
  },
): Promise<string | null> {
  const orgId = String(input.organizationId ?? "").trim();
  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(orgId) || !isUuidString(storeId)) return null;

  const slipFnsku = normalizeExpectedIdentifierKey(input.fnsku);
  const slipSku = normalizeExpectedIdentifierKey(input.sku ?? input.upc);
  if (!slipFnsku && !slipSku) return null;

  const normSlipCode = normalizeExpectedIdentifierKey(input.packageSlipCode);
  const normTracking = normalizeTrackingKey(input.packageTrackingNumber ?? "");
  const orderId = String(input.orderId ?? "").trim();
  const disposition = String(input.disposition ?? "").trim();

  const preferred = String(input.preferredHintId ?? "").trim();
  if (preferred && isUuidString(preferred)) {
    const { data: pref, error: prefErr } = await supabase
      .from("expected_packages")
      .select(
        "id, sku, fnsku, tracking_number, id_slip_contents, expected_scan_quantity, build_source, order_id, disposition, parent_expected_package_id",
      )
      .eq("id", preferred)
      .eq("organization_id", orgId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (!prefErr && pref && !(pref as { parent_expected_package_id?: string | null }).parent_expected_package_id) {
      const row = pref as AllocatableEpRow;
      if (scoreAllocatableEpRow(row, { slipFnsku, slipSku, normSlipCode, normTracking, orderId, disposition }) >= 0) {
        return row.id;
      }
    }
  }

  const orFilters: string[] = [];
  const fnskuRaw = String(input.fnsku ?? "").trim();
  const skuRaw = String(input.sku ?? input.upc ?? "").trim();
  if (fnskuRaw) {
    orFilters.push(`fnsku.ilike.${fnskuRaw}`);
    orFilters.push(`sku.ilike.${fnskuRaw}`);
  }
  if (skuRaw && skuRaw !== fnskuRaw) {
    orFilters.push(`fnsku.ilike.${skuRaw}`);
    orFilters.push(`sku.ilike.${skuRaw}`);
  }
  if (!orFilters.length) return null;

  const { data, error } = await supabase
    .from("expected_packages")
    .select(
      "id, sku, fnsku, tracking_number, id_slip_contents, expected_scan_quantity, build_source, order_id, disposition",
    )
    .eq("organization_id", orgId)
    .eq("store_id", storeId)
    .is("parent_expected_package_id", null)
    .gt("expected_scan_quantity", 0)
    .or(orFilters.join(","))
    .limit(48);
  if (error) throw error;

  const scored = (data ?? [])
    .map((r) => {
      const row = r as AllocatableEpRow;
      return { row, score: scoreAllocatableEpRow(row, { slipFnsku, slipSku, normSlipCode, normTracking, orderId, disposition }) };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.row.id ?? null;
}

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
    /** Used to replace raw RPC errors (e.g. `no_allocatable_expected`). */
    errorContext?: AllocationErrorContext;
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
    return {
      ok: false,
      error: humanizeExpectedAllocationError(error.message, input.errorContext),
      rows: [],
    };
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
      error: humanizeExpectedAllocationError(
        failed.error_message ?? "Allocation failed for one or more return items.",
        input.errorContext,
      ),
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

/** Re-scope allocated units after package parent move (v2: move_return_item_parent per row). */
export async function moveExpectedItemsForPackageScope(
  supabase: SupabaseClient,
  input: {
    packageId: string;
    organizationId: string;
    storeId: string;
    receiveScopeKey: string;
    trackingNumber?: string | null;
    palletId?: string | null;
    actorId?: string | null;
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
    .select("id")
    .eq("package_id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);

  if (listErr) return { ok: false, error: listErr.message };

  let movedCount = 0;
  for (const row of rows ?? []) {
    const returnItemId = String((row as { id?: string }).id ?? "").trim();
    if (!isUuidString(returnItemId)) continue;

    const moved = await moveReturnItemParentV2(supabase, {
      organizationId,
      returnItemId,
      packageId,
      palletId: input.palletId ?? null,
      storeId,
      receiveScopeKey: input.receiveScopeKey,
      trackingNumber: input.trackingNumber ?? null,
      actorId: input.actorId ?? null,
      reason: "package_scope_move",
    });
    if (!moved.ok) return { ok: false, error: moved.error };
    movedCount += 1;
  }

  return { ok: true, movedCount };
}

/** Keep return_items.pallet_id aligned with packages.pallet_id after move-box (physical layer). */
export async function syncReturnItemsPalletForPackage(
  supabase: SupabaseClient,
  input: {
    packageId: string;
    organizationId: string;
    palletId: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const packageId = input.packageId.trim();
  const organizationId = input.organizationId.trim();
  const palletId = input.palletId.trim();
  if (!isUuidString(packageId) || !isUuidString(organizationId) || !isUuidString(palletId)) {
    return { ok: false, error: "Invalid package, organization, or pallet id." };
  }

  const { error } = await supabase
    .from("return_items")
    .update({ pallet_id: palletId, updated_at: new Date().toISOString() })
    .eq("package_id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export function isSupabaseRpcMissingError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("could not find the function") ||
    m.includes("pgrst202") ||
    // RPC internal failure: migration table not applied (e.g. user_permissions relation missing)
    m.includes("user_permissions") ||
    (m.includes("relation") && m.includes("does not exist"))
  );
}

/** Soft-void one return_items row via v2 delete RPC (release + undo batch). */
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

  const deleted = await deleteReturnItemWithExpectedReleaseV2(supabase, {
    organizationId,
    returnItemId,
    actorId: input.updatedBy ?? null,
    reason: "app_soft_void_return_item",
  });
  if (!deleted.ok) {
    if (!isSupabaseRpcMissingError(deleted.error)) {
      return { ok: false, error: deleted.error };
    }
    const rel = await releaseExpectedItemUnit(supabase, {
      returnItemId,
      organizationId,
      softDelete: true,
    });
    if (!rel.ok) return { ok: false, error: rel.error };
    return { ok: true, released: rel.result.released };
  }

  return {
    ok: true,
    released: deleted.message === "deleted" || deleted.message === "idempotent_replay",
  };
}

/** Soft-void a package via v2 cascade RPC (child return_items + expected release). */
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

  const deleted = await deletePackageCascadeV2(supabase, {
    organizationId,
    packageId,
    actorId: input.updatedBy ?? null,
    reason: "app_soft_void_package",
  });
  if (!deleted.ok) {
    if (!isSupabaseRpcMissingError(deleted.error)) {
      return { ok: false, error: deleted.error };
    }
    const rel = await releaseExpectedItemsForPackage(supabase, {
      packageId,
      organizationId,
      softDelete: true,
    });
    if (!rel.ok) return { ok: false, error: rel.error };
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { deleted_at: now, updated_at: now };
    if (input.updatedBy && isUuidString(input.updatedBy)) patch.updated_by = input.updatedBy;
    const { error } = await supabase
      .from("packages")
      .update(patch)
      .eq("id", packageId)
      .eq("organization_id", organizationId);
    if (error) return { ok: false, error: error.message };
    return { ok: true, releasedCount: rel.releasedCount };
  }

  return { ok: true, releasedCount: deleted.itemsDeleted };
}

/** Soft-void a pallet via v2 cascade RPC. */
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

  const deleted = await deletePalletCascadeV2(supabase, {
    organizationId,
    palletId,
    actorId: input.updatedBy ?? null,
    reason: "app_soft_void_pallet",
  });
  if (!deleted.ok) {
    if (!isSupabaseRpcMissingError(deleted.error)) {
      return { ok: false, error: deleted.error };
    }
    const { data: packages, error: listErr } = await supabase
      .from("packages")
      .select("id")
      .eq("pallet_id", palletId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null);
    if (listErr) return { ok: false, error: listErr.message };

    let packagesVoided = 0;
    let releasedCount = 0;
    for (const row of packages ?? []) {
      const pkgId = String((row as { id?: string }).id ?? "").trim();
      if (!isUuidString(pkgId)) continue;
      const voided = await softVoidPackageWithExpectedRelease(supabase, {
        packageId: pkgId,
        organizationId,
        updatedBy: input.updatedBy ?? null,
      });
      if (!voided.ok) return { ok: false, error: voided.error };
      packagesVoided += 1;
      releasedCount += voided.releasedCount;
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { deleted_at: now, updated_at: now };
    if (input.updatedBy && isUuidString(input.updatedBy)) patch.updated_by = input.updatedBy;
    const { error: palErr } = await supabase
      .from("pallets")
      .update(patch)
      .eq("id", palletId)
      .eq("organization_id", organizationId);
    if (palErr) return { ok: false, error: palErr.message };

    return {
      ok: true,
      packagesVoided,
      itemsVoided: releasedCount,
      releasedCount,
    };
  }

  return {
    ok: true,
    packagesVoided: deleted.packagesDeleted,
    itemsVoided: deleted.itemsDeleted,
    releasedCount: deleted.itemsDeleted,
  };
}
