import { refFromSupabaseUrl } from "@/lib/staging-project-ref";

/** Original / production Supabase project (operator data must not receive script markers). */
export const RETURN_ITEMS_PRODUCTION_SUPABASE_REF = "kxsvedvpjldygtdbylsy";

/** Staging clone used for governed smoke / parity scripts. */
export const RETURN_ITEMS_STAGING_SUPABASE_REF = "eiqfaapyumhixxoeltgu";

const TEST_ITEM_NAME_PREFIXES = ["box-slip-alloc-parity-", "neda-item-level-smoke-"] as const;

const TEST_ITEM_NAME_EXACT = new Set(["v191 smoke item"]);

const TEST_NOTES_MARKERS = [
  "neda-item-level-receive-smoke-after-repair",
  "neda-scanner-expected-link-write-verify",
  "guard noop smoke",
  "scanner-claim-smoke",
] as const;

export type ReturnItemMarkerFields = {
  item_name?: string | null;
  sku?: string | null;
  fnsku?: string | null;
  product_identifier?: string | null;
  notes?: string | null;
};

function normMarker(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function hasTestPrefix(value: string): boolean {
  return TEST_ITEM_NAME_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** True when row fields match known script/parity smoke markers (conservative patterns only). */
export function isTestReturnItemMarker(fields: ReturnItemMarkerFields): boolean {
  const name = normMarker(fields.item_name);
  if (hasTestPrefix(name)) return true;
  if (TEST_ITEM_NAME_EXACT.has(name)) return true;
  if (name.startsWith("scanner-claim-smoke") || name.startsWith("guard noop smoke")) return true;

  for (const key of ["sku", "fnsku", "product_identifier"] as const) {
    const v = normMarker(fields[key]);
    if (v && hasTestPrefix(v)) return true;
  }

  const notes = normMarker(fields.notes);
  if (notes && TEST_NOTES_MARKERS.some((marker) => notes.includes(marker))) return true;

  return false;
}

export function isProductionSupabaseRef(ref: string | null | undefined): boolean {
  return normMarker(ref) === RETURN_ITEMS_PRODUCTION_SUPABASE_REF;
}

export function supabaseProjectRefFromEnv(): string | null {
  const url =
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim() ||
    (process.env.SUPABASE_URL ?? "").trim();
  return refFromSupabaseUrl(url);
}

/** Production runtime: NODE_ENV=production or Supabase URL targets original ref. */
export function isProductionAppRuntime(): boolean {
  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return true;
  return isProductionSupabaseRef(supabaseProjectRefFromEnv());
}

/**
 * Block test/parity marker rows from persisting in production operator data.
 * No-op in non-production runtimes (staging/dev scripts may still insert marked rows on staging).
 */
export function assertReturnItemInsertNotTestDataInProduction(fields: ReturnItemMarkerFields): void {
  if (!isProductionAppRuntime()) return;
  if (!isTestReturnItemMarker(fields)) return;
  throw new Error(
    "Test/parity return_items markers (e.g. box-slip-alloc-parity-*) are blocked in production.",
  );
}

/** Drop script/parity marker rows from scanned-unit aggregates (defensive; does not affect inserts). */
export function filterReturnItemsExcludingTestMarkers<T extends ReturnItemMarkerFields>(rows: T[]): T[] {
  return rows.filter((row) => !isTestReturnItemMarker(row));
}
