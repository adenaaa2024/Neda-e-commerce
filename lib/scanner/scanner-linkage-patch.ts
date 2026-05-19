import type { SupabaseClient } from "@supabase/supabase-js";

/** Core linkage fields present on live `return_items` / `slip_contents`. */
export const SCANNER_LINKAGE_CORE_PATCH_KEYS = [
  "resolved_product_id",
  "resolved_catalog_product_id",
  "identifier_resolution_status",
  "identifier_resolution_confidence",
] as const;

function isMissingColumnError(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes("42703") ||
    (msg.includes("column") &&
      (msg.includes("does not exist") || msg.includes("undefined column") || msg.includes("schema cache")))
  );
}

/** Drop patch keys that are not in `allowedKeys` (used after PostgREST column errors). */
export function filterLinkagePatch(
  patch: Record<string, unknown>,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const allow = new Set(allowedKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (allow.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Update a row with scanner linkage fields; retries with a smaller patch when optional columns are absent.
 */
export async function updateRowWithScannerLinkagePatch(
  supabase: SupabaseClient,
  table: string,
  rowId: string,
  patch: Record<string, unknown>,
): Promise<{ error: { message: string } | null }> {
  let attempt = { ...patch };
  for (let i = 0; i < 6; i++) {
    const { error } = await supabase.from(table).update(attempt).eq("id", rowId);
    if (!error) return { error: null };
    if (!isMissingColumnError(error.message)) return { error };
    const keys = Object.keys(attempt).filter((k) => k !== "id");
    if (keys.length <= SCANNER_LINKAGE_CORE_PATCH_KEYS.length) return { error };
    const nextKeys = keys.filter((k) =>
      (SCANNER_LINKAGE_CORE_PATCH_KEYS as readonly string[]).includes(k),
    );
    attempt = filterLinkagePatch(attempt, nextKeys.length ? nextKeys : SCANNER_LINKAGE_CORE_PATCH_KEYS);
  }
  return { error: { message: "Linkage patch failed after column fallbacks." } };
}
