/**
 * NEXT-18I — Pure helpers for the orphan / mismatch sizing run.
 *
 * No Supabase imports. No filesystem side effects (callers own writers).
 * Every function is unit-testable in isolation.
 *
 * Exposed surface:
 *   - PAGE_SIZE / POSTGREST_IN_CHUNK_SIZE  — wire-level constants
 *   - chunkIds                              — split id arrays for .in() safety
 *   - normalizeIdentifier                   — UPPER + TRIM + NULLIF
 *   - compareIdentifiers                    — returns mismatch_flags subset
 *   - hasAnyIdentifier                      — null-aware OR over identifier columns
 *   - isPrePimCohort                        — created_at < cutoff
 *   - daysBetween                           — floor((a-b)/86400000)
 *   - annotateClusterCounts                 — joins cluster pid sets with orphan/mismatch state
 *
 * Schema references:
 *   - public.products columns surfaced in plan section B
 *   - public.product_identifier_map columns: id, product_id, seller_sku, asin, fnsku,
 *     upc_code, store_id, is_primary, match_source, source_report_type,
 *     first_seen_at, last_seen_at, deleted_at
 */

export const PAGE_SIZE = 1000;
export const POSTGREST_IN_CHUNK_SIZE = 200;

export type ProductRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  upc_code: string | null;
  mfg_part_number: string | null;
  barcode: string | null;
  product_name: string | null;
  brand: string | null;
  vendor_name: string | null;
  condition: string | null;
  status: string | null;
  merge_status: string | null;
  merged_into_id: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_seen_at: string | null;
  last_catalog_sync_at: string | null;
};

export type ActiveMapRow = {
  id: string;
  product_id: string;
  organization_id: string;
  store_id: string | null;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
  upc_code: string | null;
  is_primary: boolean | null;
  match_source: string | null;
  source_report_type: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

export type InactiveMapRow = {
  id: string;
  product_id: string;
  match_source: string | null;
  source_report_type: string | null;
  deleted_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

export type CatalogBridgeRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  catalog_product_id: string;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
  upc_code: string | null;
  msku: string | null;
  title: string | null;
  source_report_type: string | null;
  match_source: string | null;
  is_primary: boolean | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

export type MismatchField = "sku" | "asin" | "fnsku" | "upc";

export function chunkIds(ids: string[], chunkSize: number = POSTGREST_IN_CHUNK_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    out.push(ids.slice(i, i + chunkSize));
  }
  return out;
}

/**
 * UPPER + TRIM + NULLIF semantics, used for sku/asin/fnsku comparisons.
 * Pass `caseFold=false` for fields like UPC where casing carries no signal but
 * the value is digits-only anyway (caseFold has no effect).
 */
export function normalizeIdentifier(value: unknown, caseFold = true): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return caseFold ? trimmed.toUpperCase() : trimmed;
}

/**
 * Compare a product row's identifier columns against a single product_identifier_map
 * row. Returns the subset of fields that are DISTINCT (in PostgreSQL `IS DISTINCT FROM`
 * semantics) after normalization. An empty array means no mismatch on the audited
 * fields.
 */
export function compareIdentifiers(p: ProductRow, m: ActiveMapRow): MismatchField[] {
  const flags: MismatchField[] = [];
  const pSku = normalizeIdentifier(p.sku);
  const mSku = normalizeIdentifier(m.seller_sku);
  if (pSku !== mSku) flags.push("sku");
  const pAsin = normalizeIdentifier(p.asin);
  const mAsin = normalizeIdentifier(m.asin);
  if (pAsin !== mAsin) flags.push("asin");
  const pFnsku = normalizeIdentifier(p.fnsku);
  const mFnsku = normalizeIdentifier(m.fnsku);
  if (pFnsku !== mFnsku) flags.push("fnsku");
  const pUpc = normalizeIdentifier(p.upc_code, false);
  const mUpc = normalizeIdentifier(m.upc_code, false);
  if (pUpc !== mUpc) flags.push("upc");
  return flags;
}

export function hasAnyIdentifier(p: ProductRow): boolean {
  return (
    normalizeIdentifier(p.sku) != null ||
    normalizeIdentifier(p.asin) != null ||
    normalizeIdentifier(p.fnsku) != null ||
    normalizeIdentifier(p.upc_code, false) != null ||
    normalizeIdentifier(p.mfg_part_number) != null ||
    normalizeIdentifier(p.barcode, false) != null
  );
}

export function isPrePimCohort(createdAt: string | null, cutoffIso: string): boolean {
  if (!createdAt) return false;
  return createdAt < cutoffIso;
}

export function daysBetween(later: string | null, earlier: string | null): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((a - b) / 86400000);
}

export type ClusterAnnotation = {
  cluster_id: string;
  n_orphan_pids: number;
  n_pids_with_active_map: number;
  n_pids_with_mismatch: number;
};

/**
 * For each cluster from NEXT-18G, compute how many of its conflicting_product_ids
 * fell into the orphan vs with-active-map vs with-mismatch buckets in this run.
 */
export function annotateClusterCounts(args: {
  clusters: Array<{ cluster_id: string; conflicting_product_ids: string[] }>;
  orphanPids: Set<string>;
  withActiveMapPids: Set<string>;
  mismatchPids: Set<string>;
}): ClusterAnnotation[] {
  return args.clusters.map((c) => {
    let nOrphan = 0;
    let nWith = 0;
    let nMis = 0;
    for (const pid of c.conflicting_product_ids) {
      if (args.orphanPids.has(pid)) nOrphan++;
      if (args.withActiveMapPids.has(pid)) nWith++;
      if (args.mismatchPids.has(pid)) nMis++;
    }
    return {
      cluster_id: c.cluster_id,
      n_orphan_pids: nOrphan,
      n_pids_with_active_map: nWith,
      n_pids_with_mismatch: nMis,
    };
  });
}

/** Internal export for tests only. */
export const __testables = { normalizeIdentifier, compareIdentifiers, daysBetween };
