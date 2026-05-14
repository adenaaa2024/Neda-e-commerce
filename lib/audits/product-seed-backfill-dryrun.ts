/**
 * NEXT-18J — Pure helpers for the orphan-product backfill dry-run classifier.
 *
 * No Supabase imports. No filesystem side effects. Every function is
 * deterministic so a re-run against the same inputs yields the same buckets.
 *
 * Exposed surface (consumed by scripts/product-seed-backfill-dryrun.ts):
 *   - identifier shape regexes (ASIN / FNSKU / UPC / SKU)
 *   - normalizeCandidate, deriveCandidates
 *   - buildIdentifierIndexes
 *   - groupDuplicateOrphans
 *   - classifyOrphan (deterministic first-match bucket selection per plan section F)
 *   - proposedMapRow
 *
 * Reference:
 *   .cursor/plans/orphan_backfill_dryrun_plan_6c219943.plan.md (sections B–F)
 */

import { createHash } from "node:crypto";

import type { ActiveMapRow, ProductRow } from "./product-seed-orphan-sizing";

// ── Identifier shape rules ──────────────────────────────────────────────────

export const ASIN_REGEX = /^B[0-9A-Z]{9}$/;
export const FNSKU_REGEX = /^X[0-9A-Z]{9}$/;
export const UPC_REGEX = /^[0-9]{8,14}$/;
/**
 * Printable ASCII, length 1..128. We deliberately exclude control chars and
 * non-ASCII so a seller_sku that round-trips through Excel without surprises.
 */
export const SKU_REGEX = /^[\x20-\x7E]{1,128}$/;

export type IdentifierKind = "sku" | "asin" | "fnsku" | "upc";
export const IDENTIFIER_KINDS: readonly IdentifierKind[] = ["sku", "asin", "fnsku", "upc"];

export type Candidate = {
  kind: IdentifierKind;
  raw: string;
  normalized: string | null;
  shape_valid: boolean;
};

export type Candidates = {
  sku: Candidate | null;
  asin: Candidate | null;
  fnsku: Candidate | null;
  upc: Candidate | null;
};

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function normalizeOne(kind: IdentifierKind, raw: string): { normalized: string; shape_valid: boolean } {
  switch (kind) {
    case "sku": {
      const n = raw;
      return { normalized: n, shape_valid: SKU_REGEX.test(n) };
    }
    case "asin": {
      const n = raw.toUpperCase();
      return { normalized: n, shape_valid: ASIN_REGEX.test(n) };
    }
    case "fnsku": {
      const n = raw.toUpperCase();
      return { normalized: n, shape_valid: FNSKU_REGEX.test(n) };
    }
    case "upc": {
      const digits = raw.replace(/[^0-9]/g, "");
      return { normalized: digits, shape_valid: UPC_REGEX.test(digits) };
    }
  }
}

export function normalizeCandidate(kind: IdentifierKind, raw: string | null | undefined): Candidate | null {
  const trimmed = trimOrNull(raw);
  if (trimmed == null) return null;
  const { normalized, shape_valid } = normalizeOne(kind, trimmed);
  return { kind, raw: trimmed, normalized: shape_valid ? normalized : null, shape_valid };
}

export function deriveCandidates(product: ProductRow): Candidates {
  return {
    sku: normalizeCandidate("sku", product.sku),
    asin: normalizeCandidate("asin", product.asin),
    fnsku: normalizeCandidate("fnsku", product.fnsku),
    upc: normalizeCandidate("upc", product.upc_code ?? product.barcode),
  };
}

export function hasAnyCandidate(c: Candidates): boolean {
  return [c.sku, c.asin, c.fnsku, c.upc].some((x) => x != null);
}

export function strongShapeValidCandidates(c: Candidates): Candidate[] {
  const out: Candidate[] = [];
  for (const k of IDENTIFIER_KINDS) {
    const v = c[k];
    if (v != null && v.shape_valid && v.normalized != null) out.push(v);
  }
  return out;
}

export function dirtyKinds(c: Candidates): IdentifierKind[] {
  const out: IdentifierKind[] = [];
  for (const k of IDENTIFIER_KINDS) {
    const v = c[k];
    if (v != null && !v.shape_valid) out.push(k);
  }
  return out;
}

// ── Identifier indexes ──────────────────────────────────────────────────────

/**
 * For each identifier kind we build two indexes:
 *   - sameStore: Map<`${store_id}|${normalized}` -> Set<product_id>>
 *   - storeWide: Map<normalized -> Set<product_id>>
 * Used both for collision detection and for already-represented-elsewhere.
 */
export type KindIndex = {
  sameStore: Map<string, Set<string>>;
  storeWide: Map<string, Set<string>>;
};

export type IdentifierIndexes = {
  /** Built from products columns (sku / asin / fnsku / upc_code). */
  productColumns: Record<IdentifierKind, KindIndex>;
  /** Built from active product_identifier_map rows (seller_sku / asin / fnsku / upc_code). */
  activeMap: Record<IdentifierKind, KindIndex>;
  /** product_id -> Set<map_row_id> for the "subsumed by another product" check. */
  mapRowsByProductId: Map<string, ActiveMapRow[]>;
};

function emptyKindIndex(): KindIndex {
  return { sameStore: new Map(), storeWide: new Map() };
}

function ensureSet<K>(m: Map<K, Set<string>>, key: K): Set<string> {
  let s = m.get(key);
  if (!s) {
    s = new Set();
    m.set(key, s);
  }
  return s;
}

function addToIndex(
  idx: KindIndex,
  storeId: string | null,
  normalized: string | null,
  productId: string,
): void {
  if (!normalized || normalized.length === 0) return;
  const storeKey = `${storeId ?? ""}|${normalized}`;
  ensureSet(idx.sameStore, storeKey).add(productId);
  ensureSet(idx.storeWide, normalized).add(productId);
}

export function buildIdentifierIndexes(products: ProductRow[], activeMap: ActiveMapRow[]): IdentifierIndexes {
  const productColumns: Record<IdentifierKind, KindIndex> = {
    sku: emptyKindIndex(),
    asin: emptyKindIndex(),
    fnsku: emptyKindIndex(),
    upc: emptyKindIndex(),
  };
  const active: Record<IdentifierKind, KindIndex> = {
    sku: emptyKindIndex(),
    asin: emptyKindIndex(),
    fnsku: emptyKindIndex(),
    upc: emptyKindIndex(),
  };
  for (const p of products) {
    const c = deriveCandidates(p);
    for (const k of IDENTIFIER_KINDS) {
      const v = c[k];
      if (v && v.normalized) addToIndex(productColumns[k], p.store_id, v.normalized, p.id);
    }
  }
  const mapRowsByProductId = new Map<string, ActiveMapRow[]>();
  for (const m of activeMap) {
    const arr = mapRowsByProductId.get(m.product_id);
    if (arr) arr.push(m);
    else mapRowsByProductId.set(m.product_id, [m]);
    const triples: Array<[IdentifierKind, string | null]> = [
      ["sku", m.seller_sku],
      ["asin", m.asin],
      ["fnsku", m.fnsku],
      ["upc", m.upc_code],
    ];
    for (const [k, raw] of triples) {
      const c = normalizeCandidate(k, raw);
      if (c && c.normalized) addToIndex(active[k], m.store_id, c.normalized, m.product_id);
    }
  }
  return { productColumns, activeMap: active, mapRowsByProductId };
}

// ── Duplicate orphan groups ─────────────────────────────────────────────────

export type DuplicateOrphanGroup = {
  group_id: string;
  contributing_bucket_count: number;
  contributing_kinds: IdentifierKind[];
  members: string[];
  size: number;
  nominated_winner_id: string;
};

/**
 * Scan the orphan universe for shared `(kind, org, store, normalized)` buckets.
 * Any two orphans that collide via at least one shape-valid identifier are
 * unioned into a single duplicate_orphan_group. Implemented with DSU so a row
 * never lands in two different groups (J11 guarantees symmetry). Winner is
 * oldest created_at, tiebreak by largest shape-valid candidate count, tiebreak
 * by lexicographic product_id.
 */
export function groupDuplicateOrphans(
  orphans: ProductRow[],
): { groups: DuplicateOrphanGroup[]; groupByPid: Map<string, DuplicateOrphanGroup> } {
  const buckets = new Map<string, string[]>();
  const bucketKindByKey = new Map<string, IdentifierKind>();
  const candidatesByPid = new Map<string, Candidates>();
  for (const p of orphans) {
    const c = deriveCandidates(p);
    candidatesByPid.set(p.id, c);
    for (const k of IDENTIFIER_KINDS) {
      const v = c[k];
      if (!v || !v.normalized) continue;
      const key = `${k}|${p.organization_id}|${p.store_id ?? ""}|${v.normalized}`;
      bucketKindByKey.set(key, k);
      const arr = buckets.get(key);
      if (arr) arr.push(p.id);
      else buckets.set(key, [p.id]);
    }
  }
  // Disjoint-set union over orphan ids.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p == null || p === x) {
      parent.set(x, x);
      return x;
    }
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  // Track which buckets contributed to which component for forensics.
  const contributingKindsByMember = new Map<string, Set<IdentifierKind>>();
  const contributingBucketsByMember = new Map<string, number>();
  for (const [key, members] of buckets) {
    if (members.length < 2) continue;
    const kind = bucketKindByKey.get(key)!;
    for (let i = 1; i < members.length; i++) union(members[0], members[i]);
    for (const m of members) {
      const s = contributingKindsByMember.get(m) ?? new Set<IdentifierKind>();
      s.add(kind);
      contributingKindsByMember.set(m, s);
      contributingBucketsByMember.set(m, (contributingBucketsByMember.get(m) ?? 0) + 1);
    }
  }
  // Collect connected components.
  const componentsByRoot = new Map<string, Set<string>>();
  for (const m of contributingKindsByMember.keys()) {
    const root = find(m);
    const s = componentsByRoot.get(root) ?? new Set<string>();
    s.add(m);
    componentsByRoot.set(root, s);
  }
  const productById = new Map(orphans.map((p) => [p.id, p]));
  const groups: DuplicateOrphanGroup[] = [];
  const groupByPid = new Map<string, DuplicateOrphanGroup>();
  for (const memberSet of componentsByRoot.values()) {
    if (memberSet.size < 2) continue;
    const sorted = [...memberSet].sort();
    const winner = sorted
      .map((pid) => productById.get(pid)!)
      .sort((a, b) => {
        const ca = a.created_at ?? "9999";
        const cb = b.created_at ?? "9999";
        if (ca !== cb) return ca < cb ? -1 : 1;
        const ka = strongShapeValidCandidates(candidatesByPid.get(a.id)!).length;
        const kb = strongShapeValidCandidates(candidatesByPid.get(b.id)!).length;
        if (ka !== kb) return kb - ka;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })[0].id;
    const groupId = createHash("sha256").update(sorted.join("|"), "utf8").digest("hex").slice(0, 16);
    const kinds = new Set<IdentifierKind>();
    let bucketCount = 0;
    for (const m of sorted) {
      const s = contributingKindsByMember.get(m);
      if (s) for (const k of s) kinds.add(k);
      bucketCount += contributingBucketsByMember.get(m) ?? 0;
    }
    const group: DuplicateOrphanGroup = {
      group_id: groupId,
      contributing_bucket_count: bucketCount,
      contributing_kinds: [...kinds].sort() as IdentifierKind[],
      members: sorted,
      size: sorted.length,
      nominated_winner_id: winner,
    };
    groups.push(group);
    for (const m of sorted) groupByPid.set(m, group);
  }
  return { groups, groupByPid };
}

// ── Bucket classification ───────────────────────────────────────────────────

export type Bucket =
  | "auto_safe_backfill_candidate"
  | "conflict_with_existing_identifier_map"
  | "conflict_with_existing_product_columns"
  | "insufficient_identifiers"
  | "upc_only_review"
  | "sku_only_review"
  | "dirty_identifier"
  | "duplicate_orphan_group"
  | "already_represented_by_active_map_elsewhere"
  | "human_review_required"
  | "do_not_touch";

export const BUCKETS: readonly Bucket[] = [
  "auto_safe_backfill_candidate",
  "conflict_with_existing_identifier_map",
  "conflict_with_existing_product_columns",
  "insufficient_identifiers",
  "upc_only_review",
  "sku_only_review",
  "dirty_identifier",
  "duplicate_orphan_group",
  "already_represented_by_active_map_elsewhere",
  "human_review_required",
  "do_not_touch",
];

export type CollisionEvidence = {
  kind: IdentifierKind;
  scope: "same_store" | "store_wide" | "product_column";
  value: string;
  other_ids: string[];
};

export type ClusterMembership = {
  cluster_id: string;
  severity: string;
};

export type ClassifyArgs = {
  orphan: ProductRow;
  candidates: Candidates;
  indexes: IdentifierIndexes;
  clusterPid: ClusterMembership | null;
  mismatchSet: Set<string>;
  duplicateGroup: DuplicateOrphanGroup | null;
};

export type Classification = {
  bucket: Bucket;
  evaluation_order: string[];
  safe_reasons: string[];
  blocked_reasons: string[];
  collision_evidence: CollisionEvidence[];
  subsumed_by_product_id: string | null;
  strong_kinds_present: IdentifierKind[];
  dirty_kinds: IdentifierKind[];
  collision_counts: {
    same_store_map: number;
    cross_store_map: number;
    product_column: number;
  };
};

/**
 * Deterministic first-match classifier following plan section F evaluation order.
 */
export function classifyOrphan(args: ClassifyArgs): Classification {
  const { orphan, candidates, indexes, clusterPid, mismatchSet, duplicateGroup } = args;
  const evaluation_order: string[] = [];
  const safe_reasons: string[] = [];
  const blocked_reasons: string[] = [];
  const collision_evidence: CollisionEvidence[] = [];

  const strong = strongShapeValidCandidates(candidates);
  const strong_kinds_present = strong.map((c) => c.kind);
  const dirty_kinds = dirtyKinds(candidates);

  // Collision tallies for downstream evidence (even if we return early).
  let sameStoreMap = 0;
  let crossStoreMap = 0;
  let productColumn = 0;
  const subsumedCandidates: Set<string> = new Set();
  const subsumedTallyByOther: Map<string, number> = new Map();

  for (const c of strong) {
    if (!c.normalized) continue;
    const value = c.normalized;
    // Same-store active map collision
    {
      const idx = indexes.activeMap[c.kind].sameStore;
      const key = `${orphan.store_id ?? ""}|${value}`;
      const others = [...(idx.get(key) ?? new Set())].filter((pid) => pid !== orphan.id);
      if (others.length > 0) {
        sameStoreMap++;
        collision_evidence.push({ kind: c.kind, scope: "same_store", value, other_ids: others });
        for (const o of others) {
          subsumedCandidates.add(o);
          subsumedTallyByOther.set(o, (subsumedTallyByOther.get(o) ?? 0) + 1);
        }
      }
    }
    // Store-wide active map collision
    {
      const idx = indexes.activeMap[c.kind].storeWide;
      const sameStoreKey = `${orphan.store_id ?? ""}|${value}`;
      const sameStoreOthers = indexes.activeMap[c.kind].sameStore.get(sameStoreKey) ?? new Set();
      const all = [...(idx.get(value) ?? new Set())].filter((pid) => pid !== orphan.id);
      const crossOnly = all.filter((pid) => !sameStoreOthers.has(pid));
      if (crossOnly.length > 0) {
        crossStoreMap++;
        collision_evidence.push({ kind: c.kind, scope: "store_wide", value, other_ids: crossOnly });
      }
    }
    // Product-column collision (same store)
    {
      const idx = indexes.productColumns[c.kind].sameStore;
      const key = `${orphan.store_id ?? ""}|${value}`;
      const others = [...(idx.get(key) ?? new Set())].filter((pid) => pid !== orphan.id);
      if (others.length > 0) {
        productColumn++;
        collision_evidence.push({ kind: c.kind, scope: "product_column", value, other_ids: others });
      }
    }
  }

  // Bucket 11: do_not_touch (structural disqualifiers).
  evaluation_order.push("do_not_touch");
  if (
    orphan.deleted_at ||
    orphan.merge_status === "merged" ||
    orphan.merge_status === "duplicate" ||
    orphan.merged_into_id
  ) {
    blocked_reasons.push(
      orphan.deleted_at
        ? "deleted_at_set"
        : orphan.merged_into_id
        ? `merged_into:${orphan.merged_into_id}`
        : `merge_status:${orphan.merge_status}`,
    );
    return result("do_not_touch");
  }

  // Bucket 4: insufficient_identifiers.
  evaluation_order.push("insufficient_identifiers");
  if (!hasAnyCandidate(candidates)) {
    blocked_reasons.push("no_identifiers_present");
    return result("insufficient_identifiers");
  }

  // Bucket 7: dirty_identifier.
  evaluation_order.push("dirty_identifier");
  if (dirty_kinds.length > 0) {
    blocked_reasons.push(`dirty_kinds:${dirty_kinds.join(",")}`);
    return result("dirty_identifier");
  }

  // Bucket 8: duplicate_orphan_group.
  evaluation_order.push("duplicate_orphan_group");
  if (duplicateGroup) {
    blocked_reasons.push(`duplicate_group_size:${duplicateGroup.size}`);
    return result("duplicate_orphan_group");
  }

  // Bucket 2: conflict_with_existing_identifier_map (same-store map collision).
  evaluation_order.push("conflict_with_existing_identifier_map");
  if (sameStoreMap > 0) {
    blocked_reasons.push(`same_store_map_collision:${sameStoreMap}`);
    return result("conflict_with_existing_identifier_map");
  }

  // Bucket 3: conflict_with_existing_product_columns.
  evaluation_order.push("conflict_with_existing_product_columns");
  if (productColumn > 0) {
    blocked_reasons.push(`product_column_collision:${productColumn}`);
    return result("conflict_with_existing_product_columns");
  }

  // Bucket 9: already_represented_by_active_map_elsewhere.
  //   The orphan's full set of shape-valid candidates is wholly subsumed by ANOTHER
  //   product (every strong candidate is owned by the same other pid).
  evaluation_order.push("already_represented_by_active_map_elsewhere");
  let subsumedBy: string | null = null;
  if (strong.length > 0) {
    for (const [pid, count] of subsumedTallyByOther) {
      if (count === strong.length) {
        subsumedBy = pid;
        break;
      }
    }
  }
  if (subsumedBy != null) {
    blocked_reasons.push(`subsumed_by:${subsumedBy}`);
    return result("already_represented_by_active_map_elsewhere", subsumedBy);
  }

  // No strong candidates? Already filtered as insufficient_identifiers, but if a
  // row has only dirty identifiers we'd be in dirty_identifier; defensively
  // route any zero-strong case to human_review_required so auto-safe stays clean.
  if (strong.length === 0) {
    blocked_reasons.push("no_strong_identifiers");
    return result("human_review_required");
  }

  // Bucket 5: upc_only_review.
  evaluation_order.push("upc_only_review");
  if (strong.length === 1 && strong[0].kind === "upc") {
    blocked_reasons.push("only_strong_id_is_upc");
    return result("upc_only_review");
  }

  // Bucket 6: sku_only_review.
  evaluation_order.push("sku_only_review");
  if (strong.length === 1 && strong[0].kind === "sku") {
    blocked_reasons.push("only_strong_id_is_sku");
    return result("sku_only_review");
  }

  // Bucket 10: human_review_required (cluster membership, mismatch set, cross-store).
  evaluation_order.push("human_review_required");
  if (clusterPid) {
    blocked_reasons.push(`in_cluster:${clusterPid.cluster_id}:severity:${clusterPid.severity}`);
    return result("human_review_required");
  }
  if (mismatchSet.has(orphan.id)) {
    blocked_reasons.push("in_mismatch_set:pim_async_csv");
    return result("human_review_required");
  }
  if (crossStoreMap > 0) {
    blocked_reasons.push(`cross_store_map_collision:${crossStoreMap}`);
    return result("human_review_required");
  }

  // Bucket 1: auto_safe_backfill_candidate.
  evaluation_order.push("auto_safe_backfill_candidate");
  if (!orphan.organization_id) {
    blocked_reasons.push("missing_organization_id");
    return result("human_review_required");
  }
  if (!orphan.store_id) {
    blocked_reasons.push("null_store_id");
    return result("human_review_required");
  }
  safe_reasons.push(`strong_identifiers:${strong_kinds_present.join(",")}`);
  if (strong_kinds_present.length >= 2) safe_reasons.push("multi_strong_id");
  safe_reasons.push("no_same_store_map_collision", "no_product_column_collision");
  if (crossStoreMap === 0) safe_reasons.push("no_cross_store_map_collision");
  safe_reasons.push("not_in_conflict_cluster", "not_in_mismatch_set", "no_duplicate_orphan_peer");
  return result("auto_safe_backfill_candidate");

  function result(bucket: Bucket, subsumed: string | null = null): Classification {
    return {
      bucket,
      evaluation_order,
      safe_reasons,
      blocked_reasons,
      collision_evidence,
      subsumed_by_product_id: subsumed,
      strong_kinds_present,
      dirty_kinds,
      collision_counts: {
        same_store_map: sameStoreMap,
        cross_store_map: crossStoreMap,
        product_column: productColumn,
      },
    };
  }
}

// ── Proposed map row (recorded in CSV / NDJSON only) ────────────────────────

export type ProposedMapRow = {
  product_id: string;
  organization_id: string;
  store_id: string | null;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
  upc_code: string | null;
  external_listing_id: string;
  match_source: "pim_orphan_backfill_dry_run";
  source_report_type: "pim_orphan_backfill_dry_run";
  is_primary: true;
  confidence_score: number;
  first_seen_at: string;
  last_seen_at: string;
};

export function proposedMapRow(
  orphan: ProductRow,
  candidates: Candidates,
  runStartedAt: string,
  confidence: number,
): ProposedMapRow {
  return {
    product_id: orphan.id,
    organization_id: orphan.organization_id,
    store_id: orphan.store_id,
    seller_sku: candidates.sku?.normalized ?? null,
    asin: candidates.asin?.normalized ?? null,
    fnsku: candidates.fnsku?.normalized ?? null,
    upc_code: candidates.upc?.normalized ?? null,
    external_listing_id: `pim_backfill_dry_run:${orphan.id}`,
    match_source: "pim_orphan_backfill_dry_run",
    source_report_type: "pim_orphan_backfill_dry_run",
    is_primary: true,
    confidence_score: confidence,
    first_seen_at: runStartedAt,
    last_seen_at: runStartedAt,
  };
}

export const __testables = { normalizeOne, trimOrNull };
