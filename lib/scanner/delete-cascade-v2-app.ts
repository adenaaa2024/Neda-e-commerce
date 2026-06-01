import type { SupabaseClient } from "@supabase/supabase-js";

import { isUuidString } from "@/lib/uuid";

type RpcRow = Record<string, unknown>;

function firstRpcRow(data: unknown): RpcRow | null {
  if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object") {
    return data[0] as RpcRow;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) return data as RpcRow;
  return null;
}

function rpcMessage(row: RpcRow | null): string {
  return String(row?.message ?? "").trim();
}

function rpcOk(row: RpcRow | null): boolean {
  return row?.ok === true || row?.ok === "t";
}

export async function deleteReturnItemWithExpectedReleaseV2(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    returnItemId: string;
    actorId?: string | null;
    idempotencyKey?: string | null;
    reason?: string | null;
  },
): Promise<
  | { ok: true; undoBatchId: string | null; message: string; idempotent: boolean }
  | { ok: false; error: string }
> {
  const organizationId = input.organizationId.trim();
  const returnItemId = input.returnItemId.trim();
  if (!isUuidString(organizationId) || !isUuidString(returnItemId)) {
    return { ok: false, error: "Invalid organization or return_item id." };
  }

  const { data, error } = await supabase.rpc("delete_return_item_with_expected_release", {
    p_organization_id: organizationId,
    p_return_item_id: returnItemId,
    p_actor_id: input.actorId && isUuidString(input.actorId) ? input.actorId : null,
    p_idempotency_key: input.idempotencyKey?.trim() || null,
    p_reason: input.reason?.trim() || "app_delete_return_item",
    p_undo_batch_id: null,
  });
  if (error) return { ok: false, error: error.message };

  const row = firstRpcRow(data);
  const msg = rpcMessage(row);
  if (!rpcOk(row)) return { ok: false, error: msg || "delete_return_item_with_expected_release failed" };

  return {
    ok: true,
    undoBatchId: row?.undo_batch_id ? String(row.undo_batch_id) : null,
    message: msg,
    idempotent: msg === "idempotent_replay" || msg === "already_deleted",
  };
}

export async function deletePackageCascadeV2(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    packageId: string;
    actorId?: string | null;
    reason?: string | null;
  },
): Promise<
  | { ok: true; undoBatchId: string | null; itemsDeleted: number; message: string }
  | { ok: false; error: string }
> {
  const organizationId = input.organizationId.trim();
  const packageId = input.packageId.trim();
  if (!isUuidString(organizationId) || !isUuidString(packageId)) {
    return { ok: false, error: "Invalid organization or package id." };
  }

  const { data, error } = await supabase.rpc("delete_package_cascade", {
    p_organization_id: organizationId,
    p_package_id: packageId,
    p_actor_id: input.actorId && isUuidString(input.actorId) ? input.actorId : null,
    p_idempotency_key: null,
    p_reason: input.reason?.trim() || "app_delete_package",
    p_undo_batch_id: null,
  });
  if (error) return { ok: false, error: error.message };

  const row = firstRpcRow(data);
  const msg = rpcMessage(row);
  if (!rpcOk(row)) return { ok: false, error: msg || "delete_package_cascade failed" };

  return {
    ok: true,
    undoBatchId: row?.undo_batch_id ? String(row.undo_batch_id) : null,
    itemsDeleted: Number(row?.items_deleted ?? 0),
    message: msg,
  };
}

export async function deletePalletCascadeV2(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    palletId: string;
    actorId?: string | null;
    reason?: string | null;
  },
): Promise<
  | {
      ok: true;
      undoBatchId: string | null;
      packagesDeleted: number;
      itemsDeleted: number;
      message: string;
    }
  | { ok: false; error: string }
> {
  const organizationId = input.organizationId.trim();
  const palletId = input.palletId.trim();
  if (!isUuidString(organizationId) || !isUuidString(palletId)) {
    return { ok: false, error: "Invalid organization or pallet id." };
  }

  const { data, error } = await supabase.rpc("delete_pallet_cascade", {
    p_organization_id: organizationId,
    p_pallet_id: palletId,
    p_actor_id: input.actorId && isUuidString(input.actorId) ? input.actorId : null,
    p_idempotency_key: null,
    p_reason: input.reason?.trim() || "app_delete_pallet",
    p_undo_batch_id: null,
  });
  if (error) return { ok: false, error: error.message };

  const row = firstRpcRow(data);
  const msg = rpcMessage(row);
  if (!rpcOk(row)) return { ok: false, error: msg || "delete_pallet_cascade failed" };

  return {
    ok: true,
    undoBatchId: row?.undo_batch_id ? String(row.undo_batch_id) : null,
    packagesDeleted: Number(row?.packages_deleted ?? 0),
    itemsDeleted: Number(row?.items_deleted ?? 0),
    message: msg,
  };
}

export async function moveReturnItemParentV2(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    returnItemId: string;
    packageId?: string | null;
    palletId?: string | null;
    storeId?: string | null;
    receiveScopeKey?: string | null;
    trackingNumber?: string | null;
    actorId?: string | null;
    reason?: string | null;
  },
): Promise<
  | { ok: true; undoBatchId: string | null; message: string }
  | { ok: false; error: string }
> {
  const organizationId = input.organizationId.trim();
  const returnItemId = input.returnItemId.trim();
  if (!isUuidString(organizationId) || !isUuidString(returnItemId)) {
    return { ok: false, error: "Invalid organization or return_item id." };
  }

  const { data, error } = await supabase.rpc("move_return_item_parent", {
    p_organization_id: organizationId,
    p_return_item_id: returnItemId,
    p_package_id: input.packageId && isUuidString(input.packageId) ? input.packageId : null,
    p_pallet_id: input.palletId && isUuidString(input.palletId) ? input.palletId : null,
    p_store_id: input.storeId && isUuidString(input.storeId) ? input.storeId : null,
    p_new_receive_scope_key: input.receiveScopeKey?.trim() || null,
    p_new_tracking_number: input.trackingNumber?.trim() || null,
    p_actor_id: input.actorId && isUuidString(input.actorId) ? input.actorId : null,
    p_reason: input.reason?.trim() || "app_move_return_item_parent",
  });
  if (error) return { ok: false, error: error.message };

  const row = firstRpcRow(data);
  const msg = rpcMessage(row);
  if (!rpcOk(row)) return { ok: false, error: msg || "move_return_item_parent failed" };

  return {
    ok: true,
    undoBatchId: row?.undo_batch_id ? String(row.undo_batch_id) : null,
    message: msg,
  };
}

export async function previewRestoreUndoBatchV2(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    undoBatchId: string;
    actorId?: string | null;
    persistConflicts?: boolean;
  },
): Promise<
  | {
      ok: true;
      canRestore: boolean;
      message: string;
      conflicts: unknown;
    }
  | { ok: false; error: string }
> {
  const organizationId = input.organizationId.trim();
  const undoBatchId = input.undoBatchId.trim();
  if (!isUuidString(organizationId) || !isUuidString(undoBatchId)) {
    return { ok: false, error: "Invalid organization or undo_batch id." };
  }

  const { data, error } = await supabase.rpc("preview_restore_undo_batch", {
    p_organization_id: organizationId,
    p_undo_batch_id: undoBatchId,
    p_actor_id: input.actorId && isUuidString(input.actorId) ? input.actorId : null,
    p_persist_conflicts: input.persistConflicts ?? false,
  });
  if (error) return { ok: false, error: error.message };

  const row = firstRpcRow(data);
  return {
    ok: true,
    canRestore: row?.can_restore === true || row?.can_restore === "t",
    message: rpcMessage(row),
    conflicts: row?.conflicts ?? null,
  };
}
