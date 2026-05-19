import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuidString } from "@/lib/uuid";

/** Session user UUID for `packages.created_by` / `pallets.created_by`; null if unauthenticated — inserts still succeed. */
export async function resolveOperatorAuditFieldsClient(
  supabase: SupabaseClient,
): Promise<{ created_by: string | null }> {
  try {
    const { data } = await supabase.auth.getUser();
    const user = data?.user ?? null;
    const uidRaw = typeof user?.id === "string" ? user.id.trim() : "";
    const uid = uidRaw && isUuidString(uidRaw) ? uidRaw : null;
    return { created_by: uid };
  } catch {
    return { created_by: null };
  }
}
