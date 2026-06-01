/**
 * Physical-scan vs bulk-orphan predicates for `return_items` (app-layer guards).
 * Aligns with inventory view gate: package-anchored scans only; excludes forecast-only rows.
 */

export type ReturnItemPhysicalAnchorRow = {
  package_id?: string | null;
  pallet_id?: string | null;
  expected_item_id?: string | null;
};

/** PostgREST `.or()` filter — excludes canonical bulk-orphan rows from operator lists/counts. */
export const EXCLUDE_BULK_ORPHAN_RETURN_ITEMS_OR_FILTER =
  "package_id.not.is.null,pallet_id.not.is.null,expected_item_id.is.null";

/**
 * Canonical bulk-orphan predicate (matches inventory view / staging remediation audits).
 * `expected_item_id` set with no physical intake anchor.
 */
export function isBulkOrphanReturnItemPattern(row: ReturnItemPhysicalAnchorRow): boolean {
  const expectedItemId = trimUuidLike(row.expected_item_id);
  if (!expectedItemId) return false;
  return !trimUuidLike(row.package_id) && !trimUuidLike(row.pallet_id);
}

export type ReturnItemInsertGuardRow = ReturnItemPhysicalAnchorRow & {
  created_by?: string | null;
};

/**
 * INSERT guard (DB trigger + app): block synthetic bulk-orphan materialization.
 * Rogue pattern: expected_item_id set, no package/pallet, no operator created_by.
 */
export function isSyntheticBulkOrphanInsertBlocked(row: ReturnItemInsertGuardRow): boolean {
  if (!isBulkOrphanReturnItemPattern(row)) return false;
  return !trimUuidLike(row.created_by);
}

export const SYNTHETIC_BULK_ORPHAN_INSERT_ERROR =
  "return_items_insert_blocked: expected_item_id requires package_id, pallet_id, or operator created_by";

/** Documented SQL form for audits and raw queries (no runtime execution here). */
export const BULK_ORPHAN_RETURN_ITEM_PREDICATE_SQL = `
  ri.expected_item_id IS NOT NULL
  AND ri.package_id IS NULL
  AND ri.pallet_id IS NULL
`.trim();

/** SQL `NOT (...)` bulk-orphan guard for a `return_items` alias (default `ri`). */
export function sqlExcludeBulkOrphanReturnItems(alias = "ri"): string {
  return `NOT (
    ${alias}.expected_item_id IS NOT NULL
    AND ${alias}.package_id IS NULL
    AND ${alias}.pallet_id IS NULL
  )`;
}

/**
 * Phase-1 physical anchor for return_item grain claim_lines (backfill, promote, queue).
 * Requires package_id; rejects bulk-orphan expected-unit rows.
 */
export function sqlPhysicalReturnItemForClaimsWhere(alias = "ri"): string {
  return `${alias}.package_id IS NOT NULL AND ${sqlExcludeBulkOrphanReturnItems(alias)}`;
}

/**
 * `return_items_with_expected_item_id` backfill lane: expected allocation link + physical scan.
 */
export function sqlReturnItemBackfillLaneWhere(alias = "ri"): string {
  return `${alias}.deleted_at IS NULL
    AND ${alias}.expected_item_id IS NOT NULL
    AND ${sqlPhysicalReturnItemForClaimsWhere(alias)}`;
}

/** In-memory gate for return_item backfill lane (matches execute/dryrun SQL). */
export function isReturnItemBackfillLaneEligible(
  row: ReturnItemPhysicalAnchorRow & { expected_item_id?: string | null },
): boolean {
  if (!trimUuidLike(row.expected_item_id)) return false;
  return isPhysicalReturnItemForClaims(row);
}

/** Physical scan unit for claims / operator counts: package required, not bulk orphan. */
export function isPhysicalReturnItemForClaims(row: ReturnItemPhysicalAnchorRow): boolean {
  if (!trimUuidLike(row.package_id)) return false;
  if (isBulkOrphanReturnItemPattern(row)) return false;
  return true;
}

export type ActivePhysicalScanCountRow = ReturnItemPhysicalAnchorRow & {
  notes?: string | null;
};

/**
 * Whether an active (non-deleted) return_item row counts toward operator physical scan totals.
 * - Package-anchored rows on a non-voided package count.
 * - Shipment Entry baseline loose rows count only when baseline tracking maps to an active package.
 * - Bulk orphans and unanchored rows never count.
 */
export function countsTowardActivePhysicalScan(
  row: ActivePhysicalScanCountRow,
  opts: {
    activePackageIds: Set<string>;
    hasActivePackageForBaselineTracking: boolean;
    baselineTrackingFromNotes: string | null;
  },
): boolean {
  if (isBulkOrphanReturnItemPattern(row)) return false;

  const pkgId = trimUuidLike(row.package_id);
  if (pkgId) {
    return opts.activePackageIds.has(pkgId);
  }

  if (opts.baselineTrackingFromNotes && opts.hasActivePackageForBaselineTracking) {
    return true;
  }

  return false;
}

function trimUuidLike(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

/** In-memory filter for list payloads that already include anchor columns. */
export function excludeBulkOrphanReturnItems<T extends ReturnItemPhysicalAnchorRow>(rows: T[]): T[] {
  return rows.filter((row) => !isBulkOrphanReturnItemPattern(row));
}

/** Apply PostgREST exclusion of bulk-orphan rows to a return_items query builder. */
export function applyExcludeBulkOrphanReturnItemsFilter<Q extends { or: (filters: string) => Q }>(
  query: Q,
): Q {
  return query.or(EXCLUDE_BULK_ORPHAN_RETURN_ITEMS_OR_FILTER);
}
