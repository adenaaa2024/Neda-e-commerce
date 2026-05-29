import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuidString } from "@/lib/uuid";
import { normalizeTrackingKey } from "./tracking-normalize";

const PAGE = 200;
const MAX_SCAN = 8000;

export type OperatorPalletTrackingRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  pallet_number: string;
  status: string | null;
  item_count: number | null;
  tracking_number: string | null;
  operator_package_count: number | null;
  carrier_name: string | null;
  /** Marketplace / removal order id on `pallets`. */
  order_id: string | null;
  shipping_label_urls: string[] | null;
  pallet_photo_urls: string[] | null;
  bol_photo_urls: string[] | null;
  created_by: string | null;
};

/** Core columns present on all deployed schemas. */
const PALLET_TRACKING_SELECT =
  "id, organization_id, store_id, pallet_number, status, item_count, tracking_number, carrier_name, order_id, shipping_label_urls, pallet_photo_urls, bol_photo_urls, created_by";

/**
 * Find an active pallet in the organization whose `tracking_number` matches `rawTracking`
 * using the same normalization as scan flows (case- and whitespace-insensitive).
 */
export async function findPalletByTrackingNormalized(
  supabase: SupabaseClient,
  organizationId: string,
  rawTracking: string,
): Promise<OperatorPalletTrackingRow | null> {
  const key = normalizeTrackingKey(rawTracking);
  if (!key) return null;

  for (let off = 0; off < MAX_SCAN; off += PAGE) {
    const { data, error } = await supabase
      .from("pallets")
      .select(PALLET_TRACKING_SELECT)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .not("tracking_number", "is", null)
      .order("id", { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) throw error;
    const hit = (data ?? []).find(
      (row) => normalizeTrackingKey(String((row as { tracking_number?: string | null }).tracking_number ?? "")) === key,
    );
    if (hit) {
      const row = hit as OperatorPalletTrackingRow;
      const { data: ext, error: extErr } = await supabase
        .from("pallets")
        .select("operator_package_count")
        .eq("id", row.id)
        .maybeSingle();
      if (!extErr && ext && typeof ext === "object" && "operator_package_count" in ext) {
        row.operator_package_count =
          (ext as { operator_package_count: number | null }).operator_package_count ?? null;
      }
      return row;
    }
    if (!data?.length || data.length < PAGE) break;
  }
  return null;
}

function palletMatchesStoreScope(
  palletStoreId: string | null | undefined,
  storeScope: string | null | undefined,
): boolean {
  const scope = String(storeScope ?? "").trim();
  const palletStore = String(palletStoreId ?? "").trim();
  if (!scope || !isUuidString(scope)) return true;
  if (!palletStore || !isUuidString(palletStore)) return true;
  return palletStore === scope;
}

/**
 * Resolve an active pallet by normalized tracking or exact `pallet_number` (case-insensitive).
 * Optional `storeId` rejects pallets bound to another store when both sides have a store id.
 */
/** Load a persisted pallet row by primary key (operator resume / package parent link). */
export async function findPalletByIdForOperator(
  supabase: SupabaseClient,
  organizationId: string,
  palletId: string,
  storeId?: string | null,
): Promise<OperatorPalletTrackingRow | null> {
  const pid = String(palletId ?? "").trim();
  if (!pid || !isUuidString(pid)) return null;

  const { data, error } = await supabase
    .from("pallets")
    .select(PALLET_TRACKING_SELECT)
    .eq("organization_id", organizationId)
    .eq("id", pid)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const hit = data as OperatorPalletTrackingRow;
  if (!palletMatchesStoreScope(hit.store_id, storeId)) return null;
  const { data: ext, error: extErr } = await supabase
    .from("pallets")
    .select("operator_package_count")
    .eq("id", hit.id)
    .maybeSingle();
  if (!extErr && ext && typeof ext === "object" && "operator_package_count" in ext) {
    hit.operator_package_count =
      (ext as { operator_package_count: number | null }).operator_package_count ?? null;
  }
  return hit;
}

export async function findPalletByTrackingOrNumber(
  supabase: SupabaseClient,
  organizationId: string,
  raw: string,
  storeId?: string | null,
): Promise<OperatorPalletTrackingRow | null> {
  const code = String(raw ?? "").trim();
  if (!code) return null;

  const byTracking = await findPalletByTrackingNormalized(supabase, organizationId, code);
  if (byTracking && palletMatchesStoreScope(byTracking.store_id, storeId)) {
    return byTracking;
  }

  const { data, error } = await supabase
    .from("pallets")
    .select(PALLET_TRACKING_SELECT)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .ilike("pallet_number", code)
    .limit(1);
  if (error) throw error;
  const hit = data?.[0] as OperatorPalletTrackingRow | undefined;
  if (!hit) return null;
  if (!palletMatchesStoreScope(hit.store_id, storeId)) return null;
  const { data: ext, error: extErr } = await supabase
    .from("pallets")
    .select("operator_package_count")
    .eq("id", hit.id)
    .maybeSingle();
  if (!extErr && ext && typeof ext === "object" && "operator_package_count" in ext) {
    hit.operator_package_count =
      (ext as { operator_package_count: number | null }).operator_package_count ?? null;
  }
  return hit;
}

export function palletHasPersistedShipmentDetails(
  row: Pick<OperatorPalletTrackingRow, "carrier_name" | "order_id" | "shipping_label_urls" | "pallet_photo_urls" | "bol_photo_urls">,
): boolean {
  const hasAnyPhotos =
    (Array.isArray(row.shipping_label_urls) && row.shipping_label_urls.length > 0) ||
    (Array.isArray(row.pallet_photo_urls) && row.pallet_photo_urls.length > 0) ||
    (Array.isArray(row.bol_photo_urls) && row.bol_photo_urls.length > 0);
  return Boolean(
    String(row.carrier_name ?? "").trim() ||
      String(row.order_id ?? "").trim() ||
      hasAnyPhotos,
  );
}
