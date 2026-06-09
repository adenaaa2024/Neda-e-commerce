import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isPackageReceiveFinalized,
  PACKAGE_RECEIVE_FINALIZED_EDIT_ERROR,
  parseOperatorItemScanFromManifestData,
} from "@/lib/scanner/package-operator-item-scan";

export async function loadPackageOperatorItemScanManifest(
  client: SupabaseClient,
  organizationId: string,
  packageId: string,
): Promise<
  | { ok: true; manifest_data: Record<string, unknown> | null; operator_item_scan: ReturnType<typeof parseOperatorItemScanFromManifestData> }
  | { ok: false; error: string }
> {
  const { data, error } = await client
    .from("packages")
    .select("manifest_data")
    .eq("id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Package not found." };

  const manifestRaw = (data as { manifest_data?: unknown }).manifest_data;
  const manifestObj =
    manifestRaw && typeof manifestRaw === "object" && !Array.isArray(manifestRaw)
      ? (manifestRaw as Record<string, unknown>)
      : null;

  return {
    ok: true,
    manifest_data: manifestObj,
    operator_item_scan: parseOperatorItemScanFromManifestData(manifestRaw),
  };
}

export function assertPackageReceiveOpenForEdits(
  operatorItemScan: ReturnType<typeof parseOperatorItemScanFromManifestData>,
): { ok: true } | { ok: false; error: string } {
  if (isPackageReceiveFinalized(operatorItemScan)) {
    return { ok: false, error: PACKAGE_RECEIVE_FINALIZED_EDIT_ERROR };
  }
  return { ok: true };
}
