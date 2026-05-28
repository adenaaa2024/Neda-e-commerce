/**
 * Client for item-level expected receive allocation RPCs.
 */

export type ReceiveExpectedWithSplitInput = {
  organization_id: string;
  store_id: string;
  parent_ep_id: string;
  /** Must equal return_item_ids.length when provided; scanner should omit and use ids only. */
  received_qty?: number | null;
  entity_type?: "box" | "pallet" | string | null;
  id_slip_contents?: string | null;
  package_id?: string | null;
  pallet_id?: string | null;
  idempotency_key?: string | null;
  /** Required for scanner receive — one physical item per id. */
  return_item_ids: string[];
};

export type AllocateItemUnitInput = {
  organization_id: string;
  store_id: string;
  parent_ep_id: string;
  return_item_id: string;
  entity_type?: "box" | "pallet" | string | null;
  id_slip_contents?: string | null;
  package_id?: string | null;
  pallet_id?: string | null;
  idempotency_key?: string | null;
};

export type ReceiveExpectedWithSplitResult = {
  allocated_ep_id: string | null;
  parent_ep_id: string | null;
  remainder_qty: number;
  overage_qty: number;
  ok: boolean;
  message: string;
};

export type ReleaseItemUnitResult = {
  ok: boolean;
  message: string;
};

/** Stable scope key mirror of SQL concat_ws (for tests / logging). */
export function buildReceiveScopeKey(input: {
  entity_type?: string | null;
  id_slip_contents?: string | null;
  package_id?: string | null;
  pallet_id?: string | null;
}): string {
  return [
    (input.entity_type ?? "box").trim().toLowerCase(),
    (input.id_slip_contents ?? "").trim(),
    input.package_id ?? "",
    input.pallet_id ?? "",
  ].join("|");
}

export function parseReceiveSplitRpcRow(row: Record<string, unknown>): ReceiveExpectedWithSplitResult {
  return {
    allocated_ep_id: row.allocated_ep_id != null ? String(row.allocated_ep_id) : null,
    parent_ep_id: row.parent_ep_id != null ? String(row.parent_ep_id) : null,
    remainder_qty: Number(row.remainder_qty ?? 0),
    overage_qty: Number(row.overage_qty ?? 0),
    ok: Boolean(row.ok),
    message: String(row.message ?? ""),
  };
}

export function parseReleaseItemUnitRow(row: Record<string, unknown>): ReleaseItemUnitResult {
  return {
    ok: Boolean(row.ok),
    message: String(row.message ?? ""),
  };
}
