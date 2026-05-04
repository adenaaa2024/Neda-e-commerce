import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Inserts a carton/box package row during operator intake.
 * Does not touch `expected_packages`.
 *
 * Minimal column set for stability: `organization_id`, `package_number` (carton barcode),
 * `pallet_id`, `status`. Optional fields (`store_id`, `manifest_data`, `rma_number`, etc.)
 * can be re-enabled once the schema and RLS expectations are aligned.
 */
export async function insertIntakeBoxPackage(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    palletId: string | null;
    packageNumber: string;
  },
): Promise<{ ok: true; packageId: string } | { ok: false; message: string }> {
  const package_number = params.packageNumber.trim();
  if (!package_number) return { ok: false, message: "Empty barcode." };

  const { data, error } = await supabase
    .from("packages")
    .insert({
      organization_id: params.organizationId,
      package_number,
      pallet_id: params.palletId,
      status: "open",
    })
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, message: error.message };
  const id = (data as { id?: string } | null)?.id;
  if (!id) return { ok: false, message: "Insert did not return an id." };
  return { ok: true, packageId: id };
}
