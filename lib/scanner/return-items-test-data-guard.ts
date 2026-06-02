/** Original / production Supabase project (operator data must not receive script markers). */
export const RETURN_ITEMS_PRODUCTION_SUPABASE_REF = "kxsvedvpjldygtdbylsy";

/** Staging clone used for governed smoke / parity scripts. */
export const RETURN_ITEMS_STAGING_SUPABASE_REF = "eiqfaapyumhixxoeltgu";

/** Known script/parity prefixes on item_name, sku, fnsku, or product_identifier. */
export const RETURN_ITEM_TEST_MARKER_PREFIXES = [
  "box-slip-alloc-parity-",
  "neda-item-level-smoke-",
] as const;

/** Substrings that identify script/parity/smoke rows (case-insensitive). */
export const RETURN_ITEM_TEST_MARKER_SUBSTRINGS = [
  "test",
  "smoke",
  "parity",
  "phase1-delete-move-parity",
  "delete-release-over-scan",
  "neda-item-level-receive-smoke",
  "neda-scanner-expected-link-write-verify",
  "guard noop smoke",
  "scanner-claim-smoke",
  "test-delete-undo-v2",
  "test-box-slip-alloc",
  "phase1-delete-move-parity-staging",
] as const;

/** item_name values that start with these prefixes (case-insensitive). */
export const RETURN_ITEM_TEST_MARKER_NAME_PREFIXES = ["v2-"] as const;

const TEST_ITEM_NAME_EXACT = new Set(["v191 smoke item", "phase1-delete-move-parity-smoke"]);

export type ReturnItemMarkerFields = {
  item_name?: string | null;
  sku?: string | null;
  fnsku?: string | null;
  product_identifier?: string | null;
  notes?: string | null;
};

export type ReturnItemSyntheticInsertFields = ReturnItemMarkerFields & {
  raw_return_data?: unknown | null;
};

export const SYNTHETIC_TEST_MARKER_INSERT_ERROR =
  "return_items_insert_blocked: synthetic test/smoke/parity marker with null raw_return_data";

function normMarker(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isProductionSupabaseRef(ref: string | null | undefined): boolean {
  return normMarker(ref) === RETURN_ITEMS_PRODUCTION_SUPABASE_REF;
}

function hasBlockedPrefix(value: string): boolean {
  return RETURN_ITEM_TEST_MARKER_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function hasBlockedSubstring(value: string): boolean {
  return RETURN_ITEM_TEST_MARKER_SUBSTRINGS.some((sub) => value.includes(sub));
}

function hasBlockedNamePrefix(value: string): boolean {
  return RETURN_ITEM_TEST_MARKER_NAME_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function fieldHasTestMarker(value: string | null | undefined): boolean {
  const v = normMarker(value);
  if (!v) return false;
  if (hasBlockedPrefix(v)) return true;
  if (hasBlockedSubstring(v)) return true;
  if (hasBlockedNamePrefix(v)) return true;
  return false;
}

/** True when any marker-like field matches known script/parity smoke patterns. */
export function isReturnItemTestDataMarker(fields: ReturnItemMarkerFields): boolean {
  const name = normMarker(fields.item_name);
  if (TEST_ITEM_NAME_EXACT.has(name)) return true;
  if (fieldHasTestMarker(name)) return true;

  for (const key of ["sku", "fnsku", "product_identifier", "notes"] as const) {
    if (fieldHasTestMarker(fields[key])) return true;
  }

  return false;
}

export function isNullRawReturnData(raw: unknown | null | undefined): boolean {
  if (raw == null) return true;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" || t === "null" || t === "[]" || t === "{}";
  }
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw === "object") return Object.keys(raw as object).length === 0;
  return false;
}

/**
 * DB + app INSERT guard: block script-style rows (null raw_return_data + test/smoke/parity markers).
 * Real scanner intake with OCR/raw payload is unaffected.
 */
export function isBlockedSyntheticTestReturnItemInsert(fields: ReturnItemSyntheticInsertFields): boolean {
  if (!isNullRawReturnData(fields.raw_return_data)) return false;
  return isReturnItemTestDataMarker(fields);
}

/** True when any marker-like field indicates known test/parity data. */
export function hasReturnItemTestDataMarker(fields: ReturnItemMarkerFields): boolean {
  return isReturnItemTestDataMarker(fields);
}

/** Shared count/filter guard: exclude known test/parity rows from scanner totals. */
export function shouldExcludeReturnItemFromScannerCounts(fields: ReturnItemMarkerFields): boolean {
  return hasReturnItemTestDataMarker(fields);
}

/** Backward-compatible alias for existing call sites. */
export const isTestReturnItemMarker = isReturnItemTestDataMarker;

/** Drop script/parity marker rows from scanned-unit aggregates (defensive; does not affect inserts). */
export function filterReturnItemsExcludingTestMarkers<T extends ReturnItemMarkerFields>(rows: T[]): T[] {
  return rows.filter((row) => !shouldExcludeReturnItemFromScannerCounts(row));
}

/** SQL predicate (return_items alias) for audit/cleanup — not executed by app runtime. */
export function sqlReturnItemsSyntheticTestMarkerWhere(alias = "ri"): string {
  const a = alias;
  const name = `lower(coalesce(${a}.item_name, ''))`;
  const sku = `lower(coalesce(${a}.sku, ''))`;
  const fnsku = `lower(coalesce(${a}.fnsku, ''))`;
  const notes = `lower(coalesce(${a}.notes, ''))`;
  const pid = `lower(coalesce(${a}.product_identifier, ''))`;
  const prefixChecks = RETURN_ITEM_TEST_MARKER_PREFIXES.map(
    (p) =>
      `(${name} LIKE '${p.replace(/'/g, "''")}%' OR ${sku} LIKE '${p.replace(/'/g, "''")}%' OR ${fnsku} LIKE '${p.replace(/'/g, "''")}%' OR ${pid} LIKE '${p.replace(/'/g, "''")}%')`,
  ).join(" OR ");
  const substrChecks = RETURN_ITEM_TEST_MARKER_SUBSTRINGS.map(
    (s) =>
      `(${name} LIKE '%${s.replace(/'/g, "''")}%' OR ${sku} LIKE '%${s.replace(/'/g, "''")}%' OR ${fnsku} LIKE '%${s.replace(/'/g, "''")}%' OR ${notes} LIKE '%${s.replace(/'/g, "''")}%' OR ${pid} LIKE '%${s.replace(/'/g, "''")}%')`,
  ).join(" OR ");
  const v2Prefix = RETURN_ITEM_TEST_MARKER_NAME_PREFIXES.map(
    (p) => `${name} LIKE '${p.replace(/'/g, "''")}%'`,
  ).join(" OR ");
  const exactNames = [...TEST_ITEM_NAME_EXACT]
    .map((n) => `${name} = '${n.replace(/'/g, "''")}'`)
    .join(" OR ");

  return `(
    ${a}.raw_return_data IS NULL
    AND (
      ${prefixChecks}
      OR ${substrChecks}
      OR ${v2Prefix}
      ${exactNames ? `OR ${exactNames}` : ""}
    )
  )`;
}
