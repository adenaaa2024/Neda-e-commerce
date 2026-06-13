/**
 * Removal source supersession read-model — SELECT/classify only; no DB writes.
 * PHASE-AMAZON-REMOVAL-SOURCE-SUPERSESSION-AND-CONFIDENCE-V1
 *
 * Stale/partial amazon_removals detail rows must not be primary truth when a newer
 * full API/report row exists for the same org/store/order/product scope.
 * Physical shipment qty (amazon_removal_shipments) remains primary physical evidence.
 */
import {
  filterExpectedPackagesForClaimGeneration,
  isCleanExpectedPackageBuildStatus,
  type ExpectedPackageRowLike,
} from "@/lib/expected-packages-conflict-status";

export type RemovalDetailRowLike = {
  id: string;
  organization_id?: string | null;
  store_id?: string | null;
  order_id?: string | null;
  sku?: string | null;
  fnsku?: string | null;
  disposition?: string | null;
  order_type?: string | null;
  shipped_quantity?: number | null;
  in_process_quantity?: number | null;
  requested_quantity?: number | null;
  tracking_number?: string | null;
  upload_id?: string | null;
  created_at?: string | null;
  /** Join from raw_report_uploads.created_at when available */
  upload_created_at?: string | null;
};

export type RemovalShipmentRowLike = {
  id: string;
  order_id?: string | null;
  sku?: string | null;
  fnsku?: string | null;
  disposition?: string | null;
  tracking_number?: string | null;
  shipped_quantity?: number | null;
  upload_id?: string | null;
  created_at?: string | null;
};

export type RemovalDetailSupersessionClass =
  | "current"
  | "superseded_stale_partial"
  | "source_conflict";

export type RemovalScopeTruthClass = "clean" | "disputed" | "source_conflict";

export type ClassifiedRemovalDetail = RemovalDetailRowLike & {
  supersession_class: RemovalDetailSupersessionClass;
  confidence: "high" | "medium" | "low";
  superseded_by_id: string | null;
  is_partial_snapshot: boolean;
  row_effective_at: string | null;
};

export type RemovalScopeTruthResult = {
  scope_key: string;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  disposition: string | null;
  order_type: string | null;
  primary_detail_id: string | null;
  primary_detail_shipped_qty: number | null;
  physical_shipment_qty: number | null;
  physical_shipment_row_id: string | null;
  source_mismatch: boolean;
  truth_class: RemovalScopeTruthClass;
  clean_quantity: number;
  disputed_quantity: number;
  detail_rows: ClassifiedRemovalDetail[];
  claim_quantity_auto_pick: null;
  notes: string[];
};

export const REMOVAL_SOURCE_SUPERSESSION_RULES = {
  version: "v1",
  priority_order: [
    "1. Newer API/report amazon_removals row supersedes older partial row (same org, store, order_id, sku/fnsku, disposition/order_type when present)",
    "2. Partial marker: in_process_quantity > 0 OR shipped_quantity lower than newer full row on same scope",
    "3. Freshness tie-break: upload_created_at DESC, then created_at DESC, then shipped_quantity DESC",
    "4. amazon_removal_shipments.shipped_quantity is primary physical shipment evidence",
    "5. Detail vs shipment qty disagree → source_mismatch; do not auto-pick claim quantity",
    "6. Clean expected qty uses trusted physical shipment row when aligned; else sum current non-superseded detail",
    "7. Disputed qty = superseded partial + overflow/conflict EP quantities (read-model only)",
    "8. Never delete or overwrite historical rows; exclude superseded/disputed from claim generation",
  ],
  partial_row_signals: ["in_process_quantity > 0", "lower shipped_quantity vs newer scope peer"],
  disagreement_policy: "mark source_mismatch; claim_quantity_auto_pick = null",
  physical_evidence_table: "amazon_removal_shipments",
  detail_evidence_table: "amazon_removals",
} as const;

export const CLEAN_QUANTITY_RULE =
  "When physical shipment row exists and build_status is clean (matched): clean_quantity = shipment.shipped_quantity. When source_mismatch: clean_quantity = shipment.shipped_quantity if shipment is trusted physical evidence; disputed detail delta goes to Needs Reconciliation.";

export const DISPUTED_QUANTITY_RULE =
  "disputed_quantity = sum(superseded_stale_partial detail shipped_qty) + sum(EP expected_scan_quantity where build_status is disputed) + abs(detail_primary - shipment) when source_mismatch and not resolved.";

function norm(s: string | null | undefined): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function normFnsku(s: string | null | undefined): string {
  return norm(s).toUpperCase();
}

function qty(v: number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function rowEffectiveAt(row: RemovalDetailRowLike): number {
  const uploadAt = row.upload_created_at ? Date.parse(row.upload_created_at) : NaN;
  const createdAt = row.created_at ? Date.parse(row.created_at) : NaN;
  if (!Number.isNaN(uploadAt)) return uploadAt;
  if (!Number.isNaN(createdAt)) return createdAt;
  return 0;
}

function rowEffectiveAtIso(row: RemovalDetailRowLike): string | null {
  return row.upload_created_at ?? row.created_at ?? null;
}

/** Product scope for supersession — tracking excluded so partial+full order lines collapse. */
export function removalDetailScopeKey(row: RemovalDetailRowLike): string {
  return [
    norm(row.organization_id),
    norm(row.store_id),
    norm(row.order_id),
    normFnsku(row.fnsku),
    norm(row.sku),
    norm(row.disposition),
    norm(row.order_type),
  ].join("|");
}

export function removalTrackingScopeKey(row: RemovalDetailRowLike): string {
  return `${removalDetailScopeKey(row)}|${norm(row.tracking_number)}`;
}

export function isPartialRemovalDetailRow(row: RemovalDetailRowLike): boolean {
  return qty(row.in_process_quantity) > 0;
}

export function compareRemovalDetailFreshness(a: RemovalDetailRowLike, b: RemovalDetailRowLike): number {
  const ta = rowEffectiveAt(a);
  const tb = rowEffectiveAt(b);
  if (tb !== ta) return tb - ta;
  const sa = qty(a.shipped_quantity);
  const sb = qty(b.shipped_quantity);
  if (sb !== sa) return sb - sa;
  const ia = qty(a.in_process_quantity);
  const ib = qty(b.in_process_quantity);
  return ia - ib;
}

function confidenceForClass(
  cls: RemovalDetailSupersessionClass,
  isPartial: boolean,
): "high" | "medium" | "low" {
  if (cls === "current" && !isPartial) return "high";
  if (cls === "current" && isPartial) return "medium";
  if (cls === "superseded_stale_partial") return "high";
  return "medium";
}

/**
 * Classify detail rows within one product scope (may span multiple tracking numbers).
 * Newest non-superseded full row is `current`; older partial/low-qty rows → superseded_stale_partial.
 */
export function classifyRemovalDetailRowsInScope(rows: RemovalDetailRowLike[]): ClassifiedRemovalDetail[] {
  if (rows.length === 0) return [];

  const sorted = [...rows].sort(compareRemovalDetailFreshness);
  const primary = sorted[0]!;
  const primaryShipped = qty(primary.shipped_quantity);

  return sorted.map((row, idx) => {
    const isPartial = isPartialRemovalDetailRow(row);
    const shipped = qty(row.shipped_quantity);
    let supersession_class: RemovalDetailSupersessionClass = "current";
    let superseded_by_id: string | null = null;

    if (row.id !== primary.id) {
      const olderPartial =
        isPartial ||
        (shipped < primaryShipped && rowEffectiveAt(row) <= rowEffectiveAt(primary));
      if (olderPartial) {
        supersession_class = "superseded_stale_partial";
        superseded_by_id = primary.id;
      } else if (shipped !== primaryShipped) {
        supersession_class = "source_conflict";
        superseded_by_id = primary.id;
      }
    } else if (idx > 0 && isPartial && primaryShipped <= qty(sorted[1]?.shipped_quantity)) {
      supersession_class = "superseded_stale_partial";
      superseded_by_id = primary.id;
    }

    return {
      ...row,
      supersession_class,
      confidence: confidenceForClass(supersession_class, isPartial),
      superseded_by_id,
      is_partial_snapshot: isPartial,
      row_effective_at: rowEffectiveAtIso(row),
    };
  });
}

export function pickPrimaryRemovalDetail(rows: ClassifiedRemovalDetail[]): ClassifiedRemovalDetail | null {
  const current = rows.filter((r) => r.supersession_class === "current");
  if (current.length === 0) return rows[0] ?? null;
  return [...current].sort(compareRemovalDetailFreshness)[0] ?? null;
}

export function sumShipmentQuantityForScope(
  shipments: RemovalShipmentRowLike[],
  scope: Pick<RemovalDetailRowLike, "order_id" | "sku" | "fnsku" | "disposition">,
  trackingNumber?: string | null,
): { qty: number; row_id: string | null } {
  const tn = trackingNumber != null ? norm(trackingNumber) : null;
  let total = 0;
  let firstId: string | null = null;
  for (const s of shipments) {
    if (norm(s.order_id) !== norm(scope.order_id)) continue;
    if (normFnsku(s.fnsku) !== normFnsku(scope.fnsku)) continue;
    if (norm(s.sku) !== norm(scope.sku)) continue;
    if (scope.disposition && norm(s.disposition) && norm(s.disposition) !== norm(scope.disposition)) continue;
    if (tn && norm(s.tracking_number) !== tn) continue;
    total += qty(s.shipped_quantity);
    if (!firstId) firstId = s.id;
  }
  return { qty: total, row_id: firstId };
}

export function resolveRemovalScopeTruth(
  detailRows: RemovalDetailRowLike[],
  shipments: RemovalShipmentRowLike[],
  opts?: { tracking_number?: string | null },
): RemovalScopeTruthResult {
  const classified = classifyRemovalDetailRowsInScope(detailRows);
  const primary = pickPrimaryRemovalDetail(classified);
  const scope = primary ?? detailRows[0] ?? {};
  const scopeKey = removalDetailScopeKey(scope as RemovalDetailRowLike);

  const physical = sumShipmentQuantityForScope(
    shipments,
    {
      order_id: scope.order_id,
      sku: scope.sku,
      fnsku: scope.fnsku,
      disposition: scope.disposition,
    },
    opts?.tracking_number,
  );

  const primaryShipped = primary ? qty(primary.shipped_quantity) : 0;
  const hasShipment = physical.qty > 0;
  const source_mismatch = hasShipment && primaryShipped > 0 && primaryShipped !== physical.qty;

  const supersededQty = classified
    .filter((r) => r.supersession_class === "superseded_stale_partial")
    .reduce((s, r) => s + qty(r.shipped_quantity), 0);

  const notes: string[] = [];
  let truth_class: RemovalScopeTruthClass = "clean";
  let clean_quantity = 0;
  let disputed_quantity = 0;

  if (source_mismatch) {
    truth_class = "source_conflict";
    clean_quantity = physical.qty;
    disputed_quantity = supersededQty + Math.abs(primaryShipped - physical.qty);
    notes.push(REMOVAL_SOURCE_SUPERSESSION_RULES.disagreement_policy);
    notes.push("clean_quantity uses physical shipment row; detail delta disputed");
  } else if (classified.some((r) => r.supersession_class === "superseded_stale_partial")) {
    truth_class = "disputed";
    clean_quantity = hasShipment ? physical.qty : primaryShipped;
    disputed_quantity = supersededQty;
    notes.push("superseded_stale_partial rows excluded from primary truth");
  } else if (hasShipment) {
    clean_quantity = physical.qty;
  } else {
    clean_quantity = primaryShipped;
  }

  if (classified.some((r) => r.supersession_class === "source_conflict")) {
    truth_class = truth_class === "clean" ? "source_conflict" : truth_class;
  }

  return {
    scope_key: scopeKey,
    order_id: scope.order_id ?? null,
    sku: scope.sku ?? null,
    fnsku: scope.fnsku ?? null,
    disposition: scope.disposition ?? null,
    order_type: scope.order_type ?? null,
    primary_detail_id: primary?.id ?? null,
    primary_detail_shipped_qty: primary ? qty(primary.shipped_quantity) : null,
    physical_shipment_qty: hasShipment ? physical.qty : null,
    physical_shipment_row_id: physical.row_id,
    source_mismatch,
    truth_class,
    clean_quantity,
    disputed_quantity,
    detail_rows: classified,
    claim_quantity_auto_pick: null,
    notes,
  };
}

export function filterRemovalDetailsForClaimGeneration<T extends RemovalDetailRowLike & { supersession_class?: RemovalDetailSupersessionClass }>(
  rows: T[],
): { claimReady: T[]; excluded: T[] } {
  const claimReady: T[] = [];
  const excluded: T[] = [];
  for (const row of rows) {
    const cls = row.supersession_class ?? "current";
    if (cls === "current" && !isPartialRemovalDetailRow(row)) claimReady.push(row);
    else excluded.push(row);
  }
  return { claimReady, excluded };
}

export type RemovalSupersessionEpFilterResult = {
  claim_ready_count: number;
  claim_ready_qty_sum: number;
  review_needed_count: number;
  review_needed_qty_sum: number;
  claim_ready_ids: string[];
  review_needed_ids: string[];
};

export function filterExpectedPackagesWithRemovalSupersession(
  epRows: ExpectedPackageRowLike[],
): RemovalSupersessionEpFilterResult {
  const { claimReady, reviewNeeded } = filterExpectedPackagesForClaimGeneration(epRows);
  return {
    claim_ready_count: claimReady.length,
    claim_ready_qty_sum: claimReady.reduce((s, r) => s + qty(r.expected_scan_quantity), 0),
    review_needed_count: reviewNeeded.length,
    review_needed_qty_sum: reviewNeeded.reduce((s, r) => s + qty(r.expected_scan_quantity), 0),
    claim_ready_ids: claimReady.map((r) => String(r.id ?? "")).filter(Boolean),
    review_needed_ids: reviewNeeded.map((r) => String(r.id ?? "")).filter(Boolean),
  };
}

export function summarizeRemovalSupersessionCounts(
  allClassified: ClassifiedRemovalDetail[],
): {
  current: number;
  superseded_stale_partial: number;
  source_conflict: number;
  partial_snapshot: number;
} {
  return {
    current: allClassified.filter((r) => r.supersession_class === "current").length,
    superseded_stale_partial: allClassified.filter((r) => r.supersession_class === "superseded_stale_partial")
      .length,
    source_conflict: allClassified.filter((r) => r.supersession_class === "source_conflict").length,
    partial_snapshot: allClassified.filter((r) => r.is_partial_snapshot).length,
  };
}

/** Group raw detail rows by scope key for batch classification. */
export function groupRemovalDetailsByScope(
  rows: RemovalDetailRowLike[],
): Map<string, RemovalDetailRowLike[]> {
  const map = new Map<string, RemovalDetailRowLike[]>();
  for (const row of rows) {
    const key = removalDetailScopeKey(row);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export function classifyAllRemovalDetailRows(
  rows: RemovalDetailRowLike[],
): ClassifiedRemovalDetail[] {
  const groups = groupRemovalDetailsByScope(rows);
  const out: ClassifiedRemovalDetail[] = [];
  for (const group of groups.values()) {
    out.push(...classifyRemovalDetailRowsInScope(group));
  }
  return out;
}

export type RemovalSupersessionReadinessSummary = {
  rules_version: "v1";
  supersession_rules: typeof REMOVAL_SOURCE_SUPERSESSION_RULES;
  clean_quantity_rule: typeof CLEAN_QUANTITY_RULE;
  disputed_quantity_rule: typeof DISPUTED_QUANTITY_RULE;
  detail_row_count: number;
  scope_groups_with_duplicates: number;
  affected_row_count: number;
  classification_counts: ReturnType<typeof summarizeRemovalSupersessionCounts>;
  sample_tracking_conflicts: Array<{
    tracking_number: string | null;
    fnsku: string | null;
    order_id: string | null;
    truth_class: RemovalScopeTruthClass;
    clean_quantity: number;
    disputed_quantity: number;
  }>;
};

export function buildRemovalSupersessionReadinessSummary(
  detailRows: RemovalDetailRowLike[],
  shipmentRows: RemovalShipmentRowLike[],
  opts?: { sample_limit?: number },
): RemovalSupersessionReadinessSummary {
  const classified = classifyAllRemovalDetailRows(detailRows);
  const counts = summarizeRemovalSupersessionCounts(classified);
  const groups = groupRemovalDetailsByScope(detailRows);
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);

  const affected = classified.filter(
    (r) => r.supersession_class !== "current" || r.is_partial_snapshot,
  );

  const sampleLimit = opts?.sample_limit ?? 5;
  const conflictSamples: RemovalSupersessionReadinessSummary["sample_tracking_conflicts"] = [];

  for (const group of dupGroups.slice(0, sampleLimit * 3)) {
    const truth = resolveRemovalScopeTruth(group, shipmentRows, {
      tracking_number: group[0]?.tracking_number,
    });
    if (truth.truth_class !== "clean" || truth.source_mismatch) {
      conflictSamples.push({
        tracking_number: group[0]?.tracking_number ?? null,
        fnsku: truth.fnsku,
        order_id: truth.order_id,
        truth_class: truth.truth_class,
        clean_quantity: truth.clean_quantity,
        disputed_quantity: truth.disputed_quantity,
      });
      if (conflictSamples.length >= sampleLimit) break;
    }
  }

  return {
    rules_version: "v1",
    supersession_rules: REMOVAL_SOURCE_SUPERSESSION_RULES,
    clean_quantity_rule: CLEAN_QUANTITY_RULE,
    disputed_quantity_rule: DISPUTED_QUANTITY_RULE,
    detail_row_count: detailRows.length,
    scope_groups_with_duplicates: dupGroups.length,
    affected_row_count: affected.length,
    classification_counts: counts,
    sample_tracking_conflicts: conflictSamples,
  };
}

export function isRemovalDetailClaimReady(row: ClassifiedRemovalDetail): boolean {
  return row.supersession_class === "current" && !row.is_partial_snapshot;
}

export function epRowIsClaimReadyWithSupersession(
  epRow: ExpectedPackageRowLike & { source_detail_row_id?: string | null },
  detailById: Map<string, ClassifiedRemovalDetail>,
): boolean {
  if (!isCleanExpectedPackageBuildStatus(epRow.build_status)) return false;
  const detailId = epRow.source_detail_row_id != null ? String(epRow.source_detail_row_id).trim() : "";
  if (!detailId) return true;
  const detail = detailById.get(detailId);
  if (!detail) return true;
  return isRemovalDetailClaimReady(detail);
}
