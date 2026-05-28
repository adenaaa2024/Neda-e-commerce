"use server";

import { randomUUID } from "node:crypto";

import { insertReturn } from "@/app/returns/actions";
import type { ReturnInsertPayload } from "@/app/returns/returns-action-types";
import { supabaseServer } from "@/lib/supabase-server";
import { assertRowOrgAccess, resolveWriteOrganizationId } from "@/lib/server-tenant";
import { isUuidString, uuidOrNull } from "@/lib/uuid";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "@/app/returns/returns-constants";
import { hydrateReturnItemProductLinkage } from "@/lib/scanner/hydrate-return-item-product-linkage";
import type { ProductLinkageDisplayContract } from "@/lib/scanner/product-linkage-display-contract";
import { updateRowWithScannerLinkagePatch } from "@/lib/scanner/scanner-linkage-patch";
import { parseReceiveSplitRpcRow } from "@/lib/scanner/receive-expected-with-split";

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
  tracking_number?: string | null;
  entity_type?: "box" | "pallet" | string | null;
  id_slip_contents?: string | null;
  pallet_id?: string | null;
  idempotency_key?: string | null;
  marketplace?: string;
  item_name: string;
  sku?: string;
  fnsku?: string;
  asin?: string;
  conditions: string[];
  notes?: string | null;
  expiration_date?: string | null;
  batch_number?: string | null;
  /** Units to record this save (default 1). Each unit inserts one `return_items` row. */
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
  allocated_expected_package_id?: string | null;
  remainder_qty?: number;
  overage_qty?: number;
  product_linkages?: OperatorReceiveItemLinkageRow[];
};

async function resolveExpectedPackageRowId(
  orgId: string,
  storeId: string,
  hintId: string | null | undefined,
  keys: {
    sku: string;
    fnsku: string;
    disposition: string;
    order_id: string | null;
    tracking_number: string | null;
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

  const buildQuery = (unassignedOnly: boolean) => {
    let q = supabaseServer
      .from("expected_packages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .eq("sku", sku)
      .in("build_source", ["detail_shipment", "detail_remainder", "legacy"])
      .gt("expected_scan_quantity", 0);

    const fn = keys.fnsku.trim();
    if (fn) q = q.eq("fnsku", fn);

    const disp = keys.disposition.trim();
    if (disp) q = q.eq("disposition", disp);

    const oid = keys.order_id?.trim();
    if (oid) q = q.eq("order_id", oid);

    const trk = keys.tracking_number?.trim();
    if (trk) q = q.eq("tracking_number", trk);

    if (unassignedOnly) q = q.is("id_slip_contents", null);

    return q;
  };

  for (const unassignedOnly of [true, false]) {
    const { data: rows, error: listErr } = await buildQuery(unassignedOnly).limit(12);
    if (listErr) return { id: null, error: listErr.message };
    if (rows?.length === 1) return { id: String((rows[0] as { id: string }).id) };
    if (rows && rows.length > 1) {
      return {
        id: null,
        error: "Multiple expected_packages rows match — use the candidate picker to disambiguate.",
      };
    }
  }

  return { id: null, error: "Expected package row not found for this SKU/FNSKU in the current store." };
}

/**
 * Inserts one return_items row per physical unit, then allocates one EP unit per row
 * via allocate_expected_items_for_return_item_ids (no quantity-only split).
 */
export async function operatorReceiveItem(
  payload: OperatorReceiveItemInput,
): Promise<OperatorReceiveItemResult> {
  const qtyRaw = Number(payload.quantity ?? 1);
  const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.min(50, Math.floor(qtyRaw))) : 1;

  const orgId = await resolveWriteOrganizationId(payload.actor_profile_id ?? null, payload.organization_id);

  const resolved = await resolveExpectedPackageRowId(orgId, payload.store_id, payload.expected_package_id ?? null, {
    sku: payload.sku ?? "",
    fnsku: payload.fnsku ?? "",
    disposition: payload.disposition ?? "",
    order_id: payload.order_id ?? null,
    tracking_number: payload.tracking_number ?? null,
  });
  const epId = resolved.id;
  if (!epId || !isUuidString(epId)) {
    return { ok: false, error: resolved.error ?? "Could not resolve expected_packages id." };
  }

  const storeFk = payload.store_id.trim();
  const packageFk = uuidOrNull(payload.package_id?.trim() ?? null);
  const palletFk = uuidOrNull(payload.pallet_id?.trim() ?? null);
  const idempotencyKey = uuidOrNull(payload.idempotency_key?.trim() ?? null) ?? randomUUID();

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
    package_id: packageFk ?? undefined,
    pallet_id: palletFk ?? undefined,
    store_id: storeFk,
    order_id: payload.order_id?.trim() || undefined,
    photo_evidence: payload.photo_evidence ?? null,
    organization_id: orgId,
    actor_profile_id: payload.actor_profile_id ?? null,
  };

  const insertedIds: string[] = [];

  try {
    for (let i = 0; i < qty; i++) {
      const res = await insertReturn(basePayload);
      if (!res.ok || !res.data?.id) {
        for (const id of insertedIds) {
          await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
        }
        return { ok: false, error: res.error ?? "Failed to insert return item." };
      }
      insertedIds.push(res.data.id);
    }

    const { data: splitData, error: splitErr } = await supabaseServer.rpc(
      "allocate_expected_items_for_return_item_ids",
      {
        p_organization_id: orgId,
        p_store_id: storeFk,
        p_parent_ep_id: epId,
        p_return_item_ids: insertedIds,
        p_entity_type: payload.entity_type?.trim() || "box",
        p_id_slip_contents: payload.id_slip_contents?.trim() || null,
        p_package_id: packageFk,
        p_pallet_id: palletFk,
        p_idempotency_key: idempotencyKey,
      },
    );

    if (splitErr) {
      for (const id of insertedIds) {
        await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
      }
      return { ok: false, error: splitErr.message };
    }

    const splitRow = parseReceiveSplitRpcRow(
      ((splitData as Record<string, unknown>[] | null)?.[0] ?? {}) as Record<string, unknown>,
    );

    if (!splitRow.ok && splitRow.message !== "overage_only") {
      for (const id of insertedIds) {
        await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
      }
      return { ok: false, error: splitRow.message || "Receive split failed." };
    }

    const product_linkages: OperatorReceiveItemLinkageRow[] = [];
    for (const returnItemId of insertedIds) {
      const { linkage } = await hydrateReturnItemProductLinkage(supabaseServer, returnItemId, orgId);
      if (linkage) {
        product_linkages.push({ return_item_id: returnItemId, product_linkage: linkage });
      }
    }

    return {
      ok: true,
      insertedIds,
      expected_package_id: splitRow.parent_ep_id ?? epId,
      allocated_expected_package_id: splitRow.allocated_ep_id,
      remainder_qty: splitRow.remainder_qty,
      overage_qty: splitRow.overage_qty,
      product_linkages,
    };
  } catch (e) {
    for (const id of insertedIds) {
      await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
    }
    return { ok: false, error: e instanceof Error ? e.message : "Receive failed." };
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
