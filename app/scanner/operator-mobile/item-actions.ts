"use server";

import { insertReturn } from "@/app/returns/actions";
import type { ReturnInsertPayload } from "@/app/returns/returns-action-types";
import { supabaseServer } from "@/lib/supabase-server";
import { assertRowOrgAccess, resolveWriteOrganizationId } from "@/lib/server-tenant";
import { isUuidString, uuidOrNull } from "@/lib/uuid";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "@/app/returns/returns-constants";
import { hydrateReturnItemProductLinkage } from "@/lib/scanner/hydrate-return-item-product-linkage";
import type { ProductLinkageDisplayContract } from "@/lib/scanner/product-linkage-display-contract";
import {
  allocateExpectedItemsForReturnItemIds,
  buildReceiveScopeKey,
  fetchPackageReceiveContext,
  humanizeExpectedAllocationError,
  releaseExpectedItemUnit,
  resolveAllocatableExpectedPackageHint,
  softVoidReturnItemWithExpectedRelease,
} from "@/lib/scanner/receive-expected-with-split";
import { updateRowWithScannerLinkagePatch } from "@/lib/scanner/scanner-linkage-patch";
import {
  guardBatchQuantityBackendError,
} from "@/lib/scanner/batch-quantity-backend-guard";

export type OperatorReceiveItemInput = {
  organization_id?: string;
  actor_profile_id?: string | null;
  store_id: string;
  /** Current carton package id (nullable only when UI runs in degraded/demo mode). */
  package_id: string | null;
  /** Client hint — resolved server-side against `expected_packages` when missing or stale. */
  expected_package_id?: string | null;
  /** Fallback keys when id lookup fails (same store + org). */
  disposition?: string | null;
  marketplace?: string;
  item_name: string;
  sku?: string;
  fnsku?: string;
  asin?: string;
  conditions: string[];
  notes?: string | null;
  expiration_date?: string | null;
  batch_number?: string | null;
  /** Units in this receive batch (default 1). One `return_items` row with `scanned_quantity`. */
  quantity?: number;
  photo_evidence?: ReturnInsertPayload["photo_evidence"];
  order_id?: string | null;
};

export type OperatorReceiveItemLinkageRow = {
  return_item_id: string;
  product_linkage: ProductLinkageDisplayContract;
};

export type OperatorReceiveItemResult = {
  ok: boolean;
  error?: string;
  insertedIds?: string[];
  expected_package_id?: string;
  /** Hydrated catalog linkage per inserted `return_items` row (server-built; no client catalog queries). */
  product_linkages?: OperatorReceiveItemLinkageRow[];
};

function isMissingColumnError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("42703") ||
    (m.includes("column") &&
      (m.includes("does not exist") || m.includes("undefined column") || m.includes("schema cache")))
  );
}

async function patchReturnItemExpectedLinkage(
  returnItemId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let attempt = { ...patch };
  const optionalKeys = Object.keys(attempt);
  for (let i = 0; i < optionalKeys.length + 1; i++) {
    const { error } = await supabaseServer.from(RETURN_ITEMS_TABLE).update(attempt).eq("id", returnItemId);
    if (!error) return { ok: true };
    if (!isMissingColumnError(error.message)) return { ok: false, error: error.message };
    const colMatch = /column\s+["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i.exec(error.message);
    if (colMatch?.[1] && colMatch[1] in attempt) {
      const { [colMatch[1]]: _drop, ...rest } = attempt;
      attempt = rest;
    } else {
      const next = Object.keys(attempt);
      if (!next.length) return { ok: true };
      const { [next[next.length - 1]!]: _drop, ...rest } = attempt;
      attempt = rest;
    }
    if (!Object.keys(attempt).length) return { ok: true };
  }
  return { ok: false, error: "Could not patch expected linkage columns." };
}

/**
 * Resolves the canonical `expected_packages.id` for receive + counter bump.
 * Prefers UUID hint when it exists in (org, store); otherwise matches sku/fnsku/disposition/order/tracking.
 */
async function resolveExpectedPackageRowId(
  orgId: string,
  storeId: string,
  hintId: string | null | undefined,
  keys: {
    sku: string;
    fnsku: string;
    disposition: string;
    order_id: string | null;
  },
): Promise<{ id: string | null; error?: string }> {
  const sku = keys.sku.trim();
  if (!sku) return { id: null, error: "SKU required to link expected_packages row." };

  const sid = storeId.trim();
  if (!isUuidString(sid)) return { id: null, error: "Invalid store_id." };

  const hint = hintId?.trim();
  if (hint && isUuidString(hint)) {
    const { data, error } = await supabaseServer
      .from("expected_packages")
      .select("id")
      .eq("id", hint)
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .maybeSingle();
    if (error) return { id: null, error: error.message };
    if (data && (data as { id?: string }).id) return { id: String((data as { id: string }).id) };
  }

  let q = supabaseServer
    .from("expected_packages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .eq("sku", sku);

  const fn = keys.fnsku.trim();
  if (fn) {
    q = q.eq("fnsku", fn);
  }

  const disp = keys.disposition.trim();
  if (disp) {
    q = q.eq("disposition", disp);
  }

  const oid = keys.order_id?.trim();
  if (oid) {
    q = q.eq("order_id", oid);
  }

  const { data: rows, error: listErr } = await q.limit(12);
  if (listErr) return { id: null, error: listErr.message };
  if (!rows?.length) {
    return { id: null, error: "Expected package row not found for this SKU/FNSKU in the current store." };
  }
  if (rows.length > 1) {
    return {
      id: null,
      error: "Multiple expected_packages rows match — use the candidate picker to disambiguate.",
    };
  }
  return { id: String((rows[0] as { id: string }).id) };
}

/**
 * Item-level receive: inserts one `return_items` row (`scanned_quantity` = qty) and allocates
 * expected units via `allocate_expected_items_for_return_item_ids`.
 */
export async function operatorReceiveItem(
  payload: OperatorReceiveItemInput,
): Promise<OperatorReceiveItemResult> {
  const qtyRaw = Number(payload.quantity ?? 1);
  const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.min(500, Math.floor(qtyRaw))) : 1;

  const orgId = await resolveWriteOrganizationId(payload.actor_profile_id ?? null, payload.organization_id);

  const packageIdFk = payload.package_id?.trim() || null;
  const pkgCtx = await fetchPackageReceiveContext(supabaseServer, packageIdFk);
  const receiveScopeKey = buildReceiveScopeKey({
    organizationId: orgId,
    storeId: payload.store_id.trim(),
    packageId: packageIdFk,
    slipCode: pkgCtx.slipCode,
  });

  const basePayload: ReturnInsertPayload = {
    marketplace: (payload.marketplace ?? "amazon").trim() || "amazon",
    item_name: payload.item_name.trim() || "Unknown item",
    sku: payload.sku?.trim() || undefined,
    fnsku: payload.fnsku?.trim() || undefined,
    asin: payload.asin?.trim() || undefined,
    conditions: payload.conditions,
    notes: payload.notes?.trim() || undefined,
    expiration_date: payload.expiration_date?.trim() || undefined,
    batch_number: payload.batch_number?.trim() || undefined,
    package_id: packageIdFk ?? undefined,
    store_id: payload.store_id.trim(),
    order_id: payload.order_id?.trim() || undefined,
    photo_evidence: payload.photo_evidence ?? null,
    organization_id: orgId,
    actor_profile_id: payload.actor_profile_id ?? null,
    scanned_quantity: qty,
  };

  const res = await insertReturn(basePayload);
  if (!res.ok || !res.data?.id) {
    const guarded = guardBatchQuantityBackendError(qty, res.error);
    return {
      ok: false,
      error: guarded ?? res.error ?? "Failed to insert return item.",
    };
  }

  const returnItemId = res.data.id;

  try {
    const allocFnsku = payload.fnsku?.trim() ?? "";
    const allocSku = payload.sku?.trim() ?? "";
    let expectedHint = payload.expected_package_id?.trim() ?? "";
    if (!expectedHint || !isUuidString(expectedHint)) {
      try {
        const resolved = await resolveAllocatableExpectedPackageHint(supabaseServer, {
          organizationId: orgId,
          storeId: payload.store_id.trim(),
          fnsku: allocFnsku,
          sku: allocSku,
          orderId: payload.order_id,
          disposition: payload.disposition,
          packageSlipCode: pkgCtx.slipCode,
          packageTrackingNumber: pkgCtx.trackingNumber,
          preferredHintId: payload.expected_package_id,
        });
        if (resolved) expectedHint = resolved;
      } catch (e) {
        await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", returnItemId);
        return {
          ok: false,
          error: humanizeExpectedAllocationError(
            e instanceof Error ? e.message : "Expected row lookup failed.",
            {
              fnsku: allocFnsku,
              sku: allocSku,
              slipCode: pkgCtx.slipCode,
              trackingNumber: pkgCtx.trackingNumber,
            },
          ),
        };
      }
    }

    const alloc = await allocateExpectedItemsForReturnItemIds(supabaseServer, {
      returnItemIds: [returnItemId],
      expectedPackageHintId: expectedHint && isUuidString(expectedHint) ? expectedHint : null,
      receiveScopeKey,
      errorContext: {
        fnsku: allocFnsku,
        sku: allocSku,
        slipCode: pkgCtx.slipCode,
        trackingNumber: pkgCtx.trackingNumber,
      },
    });

    if (!alloc.ok) {
      await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", returnItemId);
      return { ok: false, error: alloc.error };
    }

    const allocatedEpId = alloc.rows[0]?.allocated_expected_package_id ?? null;
    const parentEpId = alloc.rows[0]?.parent_expected_package_id ?? payload.expected_package_id ?? null;

    const product_linkages: OperatorReceiveItemLinkageRow[] = [];
    const { linkage } = await hydrateReturnItemProductLinkage(supabaseServer, returnItemId, orgId);
    if (linkage) {
      product_linkages.push({ return_item_id: returnItemId, product_linkage: linkage });
    }

    return {
      ok: true,
      insertedIds: [returnItemId],
      expected_package_id: parentEpId ?? allocatedEpId ?? undefined,
      product_linkages,
    };
  } catch (e) {
    await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", returnItemId);
    return { ok: false, error: e instanceof Error ? e.message : "Receive failed." };
  }
}

/**
 * Delete one scanned return_items row and release its expected allocation unit first.
 */
export async function operatorDeleteReturnItem(input: {
  return_item_id: string;
  organization_id?: string;
  actor_profile_id?: string | null;
}): Promise<{ ok: boolean; error?: string; released?: boolean }> {
  const returnItemId = input.return_item_id?.trim();
  if (!isUuidString(returnItemId)) {
    return { ok: false, error: "Invalid return item id." };
  }
  try {
    const orgId = await resolveWriteOrganizationId(
      input.actor_profile_id ?? null,
      input.organization_id,
    );
    await assertRowOrgAccess(input.actor_profile_id ?? null, orgId);

    const actorId = input.actor_profile_id?.trim();
    const voided = await softVoidReturnItemWithExpectedRelease(supabaseServer, {
      returnItemId,
      organizationId: orgId,
      updatedBy: actorId && isUuidString(actorId) ? actorId : null,
    });
    if (!voided.ok) return { ok: false, error: voided.error };

    return { ok: true, released: voided.released };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed." };
  }
}

/**
 * Operator-only correction: set `return_items.resolved_product_id` to an existing `products.id`
 * (same org + store as the return line). Audited in `return_audit_log`. Does not create or merge products.
 */
export async function manualOverrideReturnItemProductResolution(input: {
  return_item_id: string;
  resolved_product_id: string;
  actor_profile_id?: string | null;
  actor?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const rid = input.return_item_id?.trim();
  const pid = input.resolved_product_id?.trim();
  if (!isUuidString(rid) || !isUuidString(pid)) {
    return { ok: false, error: "Invalid return item or product id." };
  }
  try {
    const { data: row, error: loadErr } = await supabaseServer
      .from(RETURN_ITEMS_TABLE)
      .select(`id, organization_id, store_id, ${RETURN_SCANNER_LINKAGE_SELECT}`)
      .eq("id", rid)
      .maybeSingle();
    if (loadErr) return { ok: false, error: loadErr.message };
    if (!row || typeof row !== "object") return { ok: false, error: "Return item not found." };
    const rec = row as Record<string, unknown>;
    const orgId = String(rec.organization_id ?? "").trim();
    const storeId = String(rec.store_id ?? "").trim();
    await assertRowOrgAccess(input.actor_profile_id ?? null, orgId);
    if (!isUuidString(storeId)) {
      return { ok: false, error: "Return item has no store — cannot verify catalog product." };
    }

    const { data: prod, error: pe } = await supabaseServer
      .from("products")
      .select("id")
      .eq("id", pid)
      .eq("organization_id", orgId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (pe) return { ok: false, error: pe.message };
    if (!prod) return { ok: false, error: "Product not found for this organization and store." };

    const prevResolved = String(rec.resolved_product_id ?? "").trim();

    const patch: Record<string, unknown> = {
      resolved_product_id: pid,
      resolved_catalog_product_id: null,
      identifier_resolution_status: "resolved",
      identifier_resolution_confidence: null,
      identifier_resolution_source: "manual_override",
    };

    const { error: upErr } = await updateRowWithScannerLinkagePatch(
      supabaseServer,
      RETURN_ITEMS_TABLE,
      rid,
      patch,
    );
    if (upErr) return { ok: false, error: upErr.message };

    const actorLabel = (input.actor ?? "operator").trim() || "operator";
    await supabaseServer.from("return_audit_log").insert({
      organization_id: orgId,
      return_id: rid,
      pallet_id: null,
      action: "updated",
      field: "scanner_product_manual_override",
      old_value: prevResolved || null,
      new_value: pid,
      actor: actorLabel,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Manual override failed." };
  }
}
