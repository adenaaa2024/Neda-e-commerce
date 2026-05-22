/**
 * NEXT-18B — pure 11-bucket classifier for product-seed candidate rows.
 *
 * No Supabase imports. No I/O. Pure function `classify(input) -> ClassifyOutput`.
 * The orchestrator (scripts/product-seed-dry-run-report.ts) is responsible for
 * extracting identifiers from a source row, probing the in-memory indices, and
 * calling `classify` to produce a bucket assignment + evidence JSON.
 *
 * Buckets and ranks mirror NEXT-18A section G + the safe-matching hierarchy
 * documented in NEXT-18B section G. See .cursor/plans/product_seed_dry_run_plan_06dbbf82.plan.md.
 */

export const IDENTIFIER_TYPES = [
  "seller_sku",
  "asin",
  "fnsku",
  "upc",
  "listing_id",
] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

export const BUCKET_LABELS: readonly {
  readonly id: number;
  readonly label: string;
  readonly description: string;
}[] = [
  { id: 1, label: "already_resolved", description: "Source row already has product_id / resolved_product_id." },
  { id: 2, label: "existing_via_identifier_map", description: "Existing product matched via product_identifier_map (deleted_at IS NULL)." },
  { id: 3, label: "existing_via_products", description: "Existing product matched via products direct columns." },
  { id: 4, label: "safe_new_candidate", description: "Safe new product candidate — passes all section E gates." },
  { id: 5, label: "ambiguous_conflict", description: "Ambiguous identifier conflict — fan-out, cross-product, column collision, or multi-token." },
  { id: 6, label: "upc_only", description: "UPC-only candidate — never auto-create." },
  { id: 7, label: "name_only", description: "Name/title only — never auto-create." },
  { id: 8, label: "missing_org_or_store", description: "Missing required organization_id or store_id." },
  { id: 9, label: "missing_identifiers", description: "Has org/store but no useful identifier or title." },
  { id: 10, label: "dirty_identifier", description: "Identifier shape invalid (Excel error tokens, malformed values)." },
  { id: 11, label: "human_review", description: "Requires human review — falls through every other rule." },
];

export const BUCKET_BY_ID = new Map(BUCKET_LABELS.map((b) => [b.id, b]));

export type IdentifierMap = Partial<Record<IdentifierType | "title", string | null>>;
export type IdentifierSource = Partial<Record<IdentifierType | "title", "native" | "raw_data" | "raw_payload" | "none">>;
export type ShapeValidationResult = Partial<Record<IdentifierType, "valid" | "invalid" | "absent">>;

/** A single hit from the in-memory identifier-map or products lookup. */
export type LookupHit = {
  product_id: string | null;
  source_id: string;
  match_source: string | null;
  store_scope: "store" | "org";
  /** True if the map row referenced a product_id that did not appear in the products index (soft-deleted / merged). */
  missing_in_products_index?: boolean;
};

/** Per-identifier-type hit set. Each array length > 1 indicates fan-out for that identifier alone (F1). */
export type LookupResult = Partial<Record<IdentifierType, LookupHit[]>> & {
  /** Direct `products` table hits keyed by sku/asin/fnsku/upc — populated separately for clarity. */
  products_direct?: Partial<Record<IdentifierType, LookupHit[]>>;
};

export type ClassifyInput = {
  sourceTable: string;
  /** True if Convention A `resolved_product_id` or Convention B `product_id` is non-null on the source row. */
  rowAlreadyResolved: boolean;
  existingResolvedProductId: string | null;
  existingResolvedCatalogProductId: string | null;
  orgId: string | null;
  storeId: string | null;
  identifiers: IdentifierMap;
  identifierSources: IdentifierSource;
  shape: ShapeValidationResult;
  identifierMapHits: LookupResult;
  productsHits: LookupResult;
  /** True if a `products` row already exists at (organization_id, store_id, sku) — blocks bucket 4. */
  productsCollisionSku: boolean;
  /** True if the row's upload_id / source_upload_id resolves in raw_report_uploads. */
  uploadResolved: boolean;
};

export type ClassifyOutput = {
  bucketId: number;
  bucketLabel: string;
  primaryReason: string;
  secondaryReasons: string[];
  existingProductIdHit: string | null;
  existingCatalogProductIdHit: string | null;
  conflictProductIds: string[];
  matchRank: number | null;
  evidence: Record<string, unknown>;
};

function unanimousProductId(hits: LookupHit[] | undefined): string | null {
  if (!hits || hits.length === 0) return null;
  const ids = new Set(hits.map((h) => h.product_id).filter((id): id is string => !!id));
  if (ids.size !== 1) return null;
  return [...ids][0] ?? null;
}

function collectDistinctProductIds(...lookups: (LookupResult | undefined)[]): string[] {
  const set = new Set<string>();
  for (const lookup of lookups) {
    if (!lookup) continue;
    for (const key of IDENTIFIER_TYPES) {
      for (const hit of lookup[key] ?? []) {
        if (hit.product_id) set.add(hit.product_id);
      }
    }
    for (const key of IDENTIFIER_TYPES) {
      for (const hit of lookup.products_direct?.[key] ?? []) {
        if (hit.product_id) set.add(hit.product_id);
      }
    }
  }
  return [...set];
}

function hasAnyValidIdentifier(identifiers: IdentifierMap, shape: ShapeValidationResult): boolean {
  for (const t of IDENTIFIER_TYPES) {
    if (identifiers[t] && shape[t] !== "invalid") return true;
  }
  return false;
}

function hasAnyShapeInvalid(shape: ShapeValidationResult): boolean {
  for (const t of IDENTIFIER_TYPES) {
    if (shape[t] === "invalid") return true;
  }
  return false;
}

function onlyUpcAvailable(identifiers: IdentifierMap, shape: ShapeValidationResult): boolean {
  const hasUpc = !!identifiers.upc && shape.upc !== "invalid";
  if (!hasUpc) return false;
  for (const t of IDENTIFIER_TYPES) {
    if (t === "upc") continue;
    if (identifiers[t] && shape[t] !== "invalid") return false;
  }
  return true;
}

function onlyTitleAvailable(identifiers: IdentifierMap, shape: ShapeValidationResult): boolean {
  if (!identifiers.title) return false;
  for (const t of IDENTIFIER_TYPES) {
    if (identifiers[t] && shape[t] !== "invalid") return false;
  }
  return true;
}

/** Resolve a unanimous product across both identifier-map and products direct hits, plus track the rank that fired. */
function resolveUnanimousAcrossLookups(
  identifierMapHits: LookupResult,
  productsHits: LookupResult,
): { productId: string | null; rank: number | null; via: "identifier_map" | "products_direct" | null } {
  // Rank 2: identifier_map by seller_sku.
  let pid = unanimousProductId(identifierMapHits.seller_sku);
  if (pid) return { productId: pid, rank: 2, via: "identifier_map" };
  // Rank 3: products direct by sku.
  pid = unanimousProductId(productsHits.products_direct?.seller_sku);
  if (pid) return { productId: pid, rank: 3, via: "products_direct" };
  // Rank 4: (asin, fnsku) joint hit — intersect their identifier-map products if both present.
  const asinPids = new Set(
    (identifierMapHits.asin ?? []).map((h) => h.product_id).filter((id): id is string => !!id),
  );
  const fnskuPids = new Set(
    (identifierMapHits.fnsku ?? []).map((h) => h.product_id).filter((id): id is string => !!id),
  );
  if (asinPids.size > 0 && fnskuPids.size > 0) {
    const intersect = [...asinPids].filter((id) => fnskuPids.has(id));
    if (intersect.length === 1) return { productId: intersect[0], rank: 4, via: "identifier_map" };
  }
  // Rank 7: seller_sku alone in identifier_map (covered by rank 2 above; also check products direct).
  // Rank 8: asin alone, unique only.
  if (asinPids.size === 1) {
    pid = [...asinPids][0];
    return { productId: pid, rank: 8, via: "identifier_map" };
  }
  // Rank 9: upc alone — handled by bucket 6 (never auto-resolve).
  return { productId: null, rank: null, via: null };
}

export function classify(input: ClassifyInput): ClassifyOutput {
  const evidence: Record<string, unknown> = {
    sourceTable: input.sourceTable,
    identifiers: input.identifiers,
    identifierSources: input.identifierSources,
    shape: input.shape,
    upload_provenance: { resolved: input.uploadResolved },
  };
  const distinctConflictIds = collectDistinctProductIds(input.identifierMapHits, input.productsHits);

  // Bucket 1 — already resolved on the source row.
  if (input.rowAlreadyResolved) {
    return {
      bucketId: 1,
      bucketLabel: "already_resolved",
      primaryReason: "row_has_resolved_product_id",
      secondaryReasons: [],
      existingProductIdHit: input.existingResolvedProductId,
      existingCatalogProductIdHit: input.existingResolvedCatalogProductId,
      conflictProductIds: [],
      matchRank: 1,
      evidence,
    };
  }

  // Bucket 8 — missing org or store. Org is strict; store has an out-of-scope exception
  // for product_identity_staging_rows which the slice does not cover yet.
  if (!input.orgId) {
    return {
      bucketId: 8,
      bucketLabel: "missing_org_or_store",
      primaryReason: "missing_organization_id",
      secondaryReasons: [],
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: [],
      matchRank: null,
      evidence,
    };
  }
  if (!input.storeId) {
    return {
      bucketId: 8,
      bucketLabel: "missing_org_or_store",
      primaryReason: "missing_store_id",
      secondaryReasons: [],
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: [],
      matchRank: null,
      evidence,
    };
  }

  const anyValid = hasAnyValidIdentifier(input.identifiers, input.shape);
  const anyInvalid = hasAnyShapeInvalid(input.shape);

  // Bucket 10 — dirty/corrupted identifier with no valid identifier remaining.
  if (anyInvalid && !anyValid) {
    return {
      bucketId: 10,
      bucketLabel: "dirty_identifier",
      primaryReason: "all_identifiers_shape_invalid",
      secondaryReasons: [],
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: [],
      matchRank: null,
      evidence,
    };
  }

  // Bucket 9 — no identifiers and no usable title.
  if (!anyValid && !input.identifiers.title) {
    return {
      bucketId: 9,
      bucketLabel: "missing_identifiers",
      primaryReason: "no_identifier_no_title",
      secondaryReasons: [],
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: [],
      matchRank: null,
      evidence,
    };
  }

  // Bucket 7 — title-only.
  if (!anyValid && input.identifiers.title) {
    return {
      bucketId: 7,
      bucketLabel: "name_only",
      primaryReason: "title_only_no_identifier",
      secondaryReasons: [],
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: [],
      matchRank: 11,
      evidence,
    };
  }

  // Bucket 6 — UPC-only (only UPC valid, nothing else valid).
  if (onlyUpcAvailable(input.identifiers, input.shape)) {
    return {
      bucketId: 6,
      bucketLabel: "upc_only",
      primaryReason: "upc_only_review",
      secondaryReasons: [],
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: distinctConflictIds,
      matchRank: 9,
      evidence,
    };
  }

  // Title-only short-circuit already returned above; double-check.
  if (onlyTitleAvailable(input.identifiers, input.shape)) {
    return {
      bucketId: 7,
      bucketLabel: "name_only",
      primaryReason: "title_only_no_identifier",
      secondaryReasons: [],
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: [],
      matchRank: 11,
      evidence,
    };
  }

  // Identifier-map / products lookups: detect F1 fan-out and F2 cross-product conflicts.
  const secondary: string[] = [];

  const fanOutTypes: IdentifierType[] = [];
  for (const t of IDENTIFIER_TYPES) {
    const ids = new Set((input.identifierMapHits[t] ?? []).map((h) => h.product_id).filter(Boolean));
    if (ids.size > 1) fanOutTypes.push(t);
  }
  if (fanOutTypes.length > 0) {
    secondary.push(`f1_identifier_fan_out:${fanOutTypes.join(",")}`);
  }

  const resolution = resolveUnanimousAcrossLookups(input.identifierMapHits, input.productsHits);

  if (distinctConflictIds.length > 1) {
    return {
      bucketId: 5,
      bucketLabel: "ambiguous_conflict",
      primaryReason: "f2_cross_product_conflict",
      secondaryReasons: secondary,
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: distinctConflictIds,
      matchRank: null,
      evidence,
    };
  }

  if (resolution.productId && resolution.via === "identifier_map") {
    return {
      bucketId: 2,
      bucketLabel: "existing_via_identifier_map",
      primaryReason: `rank_${resolution.rank}_identifier_map_hit`,
      secondaryReasons: secondary,
      existingProductIdHit: resolution.productId,
      existingCatalogProductIdHit: null,
      conflictProductIds: [],
      matchRank: resolution.rank,
      evidence,
    };
  }
  if (resolution.productId && resolution.via === "products_direct") {
    return {
      bucketId: 3,
      bucketLabel: "existing_via_products",
      primaryReason: `rank_${resolution.rank}_products_direct_hit`,
      secondaryReasons: secondary,
      existingProductIdHit: resolution.productId,
      existingCatalogProductIdHit: null,
      conflictProductIds: [],
      matchRank: resolution.rank,
      evidence,
    };
  }

  // Section E gates for bucket 4 (safe new):
  //   - org + store present (already enforced above)
  //   - at least one valid identifier in {asin, fnsku, seller_sku}
  //   - no shape-invalid identifiers on the row
  //   - no existing identifier-map conflict (distinctConflictIds <= 1)
  //   - no products.(org, store, sku) collision
  //   - upload provenance resolved
  const hasHighConfidence = !!(
    (input.identifiers.seller_sku && input.shape.seller_sku !== "invalid") ||
    (input.identifiers.asin && input.shape.asin !== "invalid") ||
    (input.identifiers.fnsku && input.shape.fnsku !== "invalid")
  );

  if (!hasHighConfidence) {
    return {
      bucketId: 11,
      bucketLabel: "human_review",
      primaryReason: "no_high_confidence_identifier",
      secondaryReasons: secondary,
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: distinctConflictIds,
      matchRank: null,
      evidence,
    };
  }

  if (anyInvalid) {
    return {
      bucketId: 5,
      bucketLabel: "ambiguous_conflict",
      primaryReason: "f3_shape_invalid_alongside_valid",
      secondaryReasons: secondary,
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: distinctConflictIds,
      matchRank: null,
      evidence,
    };
  }

  if (input.productsCollisionSku) {
    return {
      bucketId: 5,
      bucketLabel: "ambiguous_conflict",
      primaryReason: "f3_products_sku_collision",
      secondaryReasons: secondary,
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: distinctConflictIds,
      matchRank: null,
      evidence,
    };
  }

  if (!input.uploadResolved) {
    return {
      bucketId: 11,
      bucketLabel: "human_review",
      primaryReason: "upload_provenance_unresolved",
      secondaryReasons: secondary,
      existingProductIdHit: null,
      existingCatalogProductIdHit: null,
      conflictProductIds: distinctConflictIds,
      matchRank: null,
      evidence,
    };
  }

  return {
    bucketId: 4,
    bucketLabel: "safe_new_candidate",
    primaryReason: "passes_section_e_gates",
    secondaryReasons: secondary,
    existingProductIdHit: null,
    existingCatalogProductIdHit: null,
    conflictProductIds: [],
    matchRank: 7,
    evidence,
  };
}
