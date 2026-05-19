import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuidString } from "@/lib/uuid";
import {
  fetchStoreDisplayNameForOrganization,
  formatUnauthorizedTrackingInStoreMessage,
} from "@/lib/scanner/operator-store-display";

export type InsertIntakeBoxPackageResult =
  | { ok: true; packageId: string; reusedExisting?: boolean }
  | { ok: false; message: string };

/**
 * Inserts a carton/box package row during operator intake, or reuses + refreshes an existing
 * row when the same `package_code` already exists for the org (active rows). Many packages may
 * share the same parent `tracking_number` (shipment / pallet id) — it is not used for dedupe.
 * Does not touch `expected_packages`.
 */
export async function insertIntakeBoxPackage(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    palletId: string | null;
    packageNumber: string;
    /** Parent shipment / pallet tracking — optional, non-unique on `packages`. */
    shipmentTrackingNumber?: string | null;
    storeId?: string | null;
    /** Profiles / auth UUID for `packages.created_by`. */
    created_by?: string | null;
  },
): Promise<InsertIntakeBoxPackageResult> {
  const package_code = params.packageNumber.trim();
  if (!package_code) return { ok: false, message: "Empty barcode." };

  const org = params.organizationId.trim();
  const sid = params.storeId?.trim() ?? "";
  const cb = params.created_by?.trim() ?? "";
  const trackingPersist = (params.shipmentTrackingNumber ?? "").trim() || null;

  const pickExistingRow = async (): Promise<{ id: string; store_id: string | null } | null> => {
    const byPc = await supabase
      .from("packages")
      .select("id, store_id")
      .eq("organization_id", org)
      .is("deleted_at", null)
      .eq("package_code", package_code)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byPc.error || !byPc.data) return null;
    const id = String((byPc.data as { id?: string }).id ?? "").trim();
    if (!isUuidString(id)) return null;
    const store_id =
      typeof (byPc.data as { store_id?: unknown }).store_id === "string"
        ? String((byPc.data as { store_id: string }).store_id).trim() || null
        : null;
    return { id, store_id };
  };

  const mergeExistingRow = async (existingId: string): Promise<InsertIntakeBoxPackageResult> => {
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      package_code,
      tracking_number: trackingPersist,
      pallet_id: params.palletId,
    };
    if (sid) patch.store_id = sid;
    if (cb) patch.updated_by = cb;
    const { error: upErr } = await supabase.from("packages").update(patch).eq("id", existingId);
    if (upErr) return { ok: false, message: upErr.message };
    return { ok: true, packageId: existingId, reusedExisting: true };
  };

  const existingRow = await pickExistingRow();
  if (existingRow) {
    const exSt = String(existingRow.store_id ?? "").trim();
    const curSt = sid;
    if (exSt && isUuidString(exSt) && curSt && isUuidString(curSt) && exSt !== curSt) {
      const label = (await fetchStoreDisplayNameForOrganization(supabase, org, exSt)) ?? "";
      return { ok: false, message: formatUnauthorizedTrackingInStoreMessage(label) };
    }
    return mergeExistingRow(existingRow.id);
  }

  const insertRow: Record<string, unknown> = {
    organization_id: org,
    package_code,
    tracking_number: trackingPersist,
    pallet_id: params.palletId,
    status: "open",
  };
  if (sid) insertRow.store_id = sid;
  if (cb) {
    insertRow.created_by = cb;
    insertRow.updated_by = cb;
  }

  const { data, error } = await supabase.from("packages").insert(insertRow).select("id").maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const again = await pickExistingRow();
      if (again) {
        const exSt = String(again.store_id ?? "").trim();
        const curSt = sid;
        if (exSt && isUuidString(exSt) && curSt && isUuidString(curSt) && exSt !== curSt) {
          const label = (await fetchStoreDisplayNameForOrganization(supabase, org, exSt)) ?? "";
          return { ok: false, message: formatUnauthorizedTrackingInStoreMessage(label) };
        }
        return mergeExistingRow(again.id);
      }
    }
    return { ok: false, message: error.message };
  }
  const id = (data as { id?: string } | null)?.id;
  if (!id) return { ok: false, message: "Insert did not return an id." };
  return { ok: true, packageId: id };
}
