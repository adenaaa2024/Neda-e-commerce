import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuidString } from "@/lib/uuid";

/** Wrap store label for plain-text errors (UI does not render markdown). */
function quotedStoreLabel(storeDisplayName: string): string {
  const raw = (storeDisplayName ?? "").trim() || "another store";
  const safe = raw.replace(/"/g, "'");
  return `"${safe}"`;
}

/** Inbound tracking already exists on a pallet in a different store than the active session. */
export function formatUnauthorizedTrackingInStoreMessage(storeDisplayName: string): string {
  return `Unauthorized: This tracking is registered in ${quotedStoreLabel(storeDisplayName)}. Please switch stores to access it.`;
}

/** Package row belongs to a different store than the operator session (update / scope guard). */
export function formatUnauthorizedPackageInStoreMessage(storeDisplayName: string): string {
  return `Unauthorized: This package is registered in ${quotedStoreLabel(storeDisplayName)}. Please switch stores to access it.`;
}

export type CrossStoreUnauthorizedParsed =
  | { kind: "tracking"; storeName: string }
  | { kind: "package"; storeName: string };

/** Parse messages from {@link formatUnauthorizedTrackingInStoreMessage} / {@link formatUnauthorizedPackageInStoreMessage}. */
export function parseCrossStoreUnauthorizedMessage(message: string): CrossStoreUnauthorizedParsed | null {
  const s = String(message ?? "").trim();
  let m = s.match(/Unauthorized: This tracking is registered in "([^"]+)"\./i);
  if (m?.[1]?.trim()) return { kind: "tracking", storeName: m[1].trim() };
  m = s.match(/Unauthorized: This package is registered in "([^"]+)"\./i);
  if (m?.[1]?.trim()) return { kind: "package", storeName: m[1].trim() };
  return null;
}

/**
 * Resolve `stores.name` for a row's `store_id` within the org.
 * Does not filter `is_active` so a historic pallet/package still shows a label if the store was deactivated.
 */
export async function fetchStoreDisplayNameForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<string | null> {
  const oid = organizationId.trim();
  const sid = storeId.trim();
  if (!isUuidString(oid) || !isUuidString(sid)) return null;

  const { data, error } = await supabase
    .from("stores")
    .select("name")
    .eq("id", sid)
    .eq("organization_id", oid)
    .maybeSingle();

  if (error || !data) return null;
  const name = String((data as { name?: string | null }).name ?? "").trim();
  return name.length ? name : null;
}
