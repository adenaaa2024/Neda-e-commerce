"use server";

import { insertReturn } from "@/app/returns/actions";
import type { ReturnInsertPayload } from "@/app/returns/returns-action-types";
import { supabaseServer } from "@/lib/supabase-server";
import { resolveWriteOrganizationId } from "@/lib/server-tenant";
import { isUuidString } from "@/lib/uuid";

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
  /** Units to record this save (default 1). Each unit inserts one `returns` row and bumps EP once. */
  quantity?: number;
  photo_evidence?: ReturnInsertPayload["photo_evidence"];
  order_id?: string | null;
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
 * Inserts one `returns` row per unit and increments `expected_packages.actual_scanned_count` by the same amount.
 * Rolls back inserted returns if the EP update fails.
 */
export async function operatorReceiveItem(
  payload: OperatorReceiveItemInput,
): Promise<{ ok: boolean; error?: string; insertedIds?: string[]; expected_package_id?: string }> {
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
          await supabaseServer.from("returns").delete().eq("id", id);
        }
        return { ok: false, error: res.error ?? "Failed to insert return." };
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
        await supabaseServer.from("returns").delete().eq("id", id);
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
        await supabaseServer.from("returns").delete().eq("id", id);
      }
      return { ok: false, error: upErr.message };
    }

    return { ok: true, insertedIds, expected_package_id: epId };
  } catch (e) {
    for (const id of insertedIds) {
      await supabaseServer.from("returns").delete().eq("id", id);
    }
    return { ok: false, error: e instanceof Error ? e.message : "Receive failed." };
  }
}
