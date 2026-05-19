import type { SupabaseClient } from "@supabase/supabase-js";

export function allowOperatorUnknownPackageCreate(): boolean {
  if (typeof process === "undefined") return true;
  return process.env.NEXT_PUBLIC_OPERATOR_ALLOW_UNKNOWN_PACKAGE_CREATE !== "false";
}

/**
 * Creates a placeholder package row for an unscanned / unmatched tracking-style code so receiving can continue.
 * Requires org + store context. Prefer a **service-role** client from a server action
 * (`insertOperatorUnknownPackageAction`) so workspace org selection is not blocked by JWT RLS.
 */
export async function insertUnknownPackageForTrackingCode(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    storeId: string;
    scannedCode: string;
    created_by?: string | null;
  },
): Promise<{ ok: true; packageId: string } | { ok: false; message: string }> {
  const code = params.scannedCode.trim();
  if (!code) return { ok: false, message: "Empty code." };

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const package_code = `UNK-${suffix}`;
  const row: Record<string, unknown> = {
    organization_id: params.organizationId,
    store_id: params.storeId,
    tracking_number: code,
    package_code,
    status: "unknown_shipment",
    expected_item_count: 0,
    actual_item_count: 0,
  };
  const cb = params.created_by?.trim();
  if (cb) row.created_by = cb;

  const { data, error } = await supabase.from("packages").insert(row).select("id").maybeSingle();

  if (error) return { ok: false, message: error.message };
  const id = (data as { id?: string } | null)?.id;
  if (!id) return { ok: false, message: "Insert did not return an id." };
  return { ok: true, packageId: id };
}
