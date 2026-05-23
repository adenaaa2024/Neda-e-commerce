"use server";

import { insertReturn } from "@/app/returns/actions";
import type { ReturnInsertPayload } from "@/app/returns/returns-action-types";
import { supabaseServer } from "@/lib/supabase-server";
import { assertRowOrgAccess, resolveWriteOrganizationId } from "@/lib/server-tenant";
import { isUuidString, uuidOrNull } from "@/lib/uuid";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "@/app/returns/returns-constants";
import { hydrateReturnItemProductLinkage } from "@/lib/scanner/hydrate-return-item-product-linkage";
import type { ProductLinkageDisplayContract } from "@/lib/scanner/product-linkage-display-contract";
import { updateRowWithScannerLinkagePatch } from "@/lib/scanner/scanner-linkage-patch";

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
  /** Units to record this save (default 1). Each unit inserts one `return_items` row and bumps EP once. */
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
 * Inserts one `return_items` row per unit and increments `expected_packages.actual_scanned_count` by the same amount.
 * Rolls back inserted `return_items` rows if the EP update fails.
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
  });
  const epId = resolved.id;
  if (!epId || !isUuidString(epId)) {
    return { ok: false, error: resolved.error ?? "Could not resolve expected_packages id." };
  }

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
    package_id: payload.package_id?.trim() || undefined,
    store_id: payload.store_id.trim(),
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

    const storeFk = payload.store_id.trim();
    const { data: epRow, error: loadEpErr } = await supabaseServer
      .from("expected_packages")
      .select("actual_scanned_count")
      .eq("id", epId)
      .eq("organization_id", orgId)
      .eq("store_id", storeFk)
      .maybeSingle();

    if (loadEpErr) {
      for (const id of insertedIds) {
        await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
      }
      return { ok: false, error: loadEpErr.message };
    }

    const prev = Number((epRow as { actual_scanned_count?: number } | null)?.actual_scanned_count ?? 0);
    const next = prev + qty;

    const { error: upErr } = await supabaseServer
      .from("expected_packages")
      .update({ actual_scanned_count: next })
      .eq("id", epId)
      .eq("organization_id", orgId)
      .eq("store_id", storeFk);

    if (upErr) {
      for (const id of insertedIds) {
        await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
      }
      return { ok: false, error: upErr.message };
    }

    const product_linkages: OperatorReceiveItemLinkageRow[] = [];
    for (const returnItemId of insertedIds) {
      const { linkage } = await hydrateReturnItemProductLinkage(supabaseServer, returnItemId, orgId);
      if (linkage) {
        product_linkages.push({ return_item_id: returnItemId, product_linkage: linkage });
      }
    }

    return { ok: true, insertedIds, expected_package_id: epId, product_linkages };
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
