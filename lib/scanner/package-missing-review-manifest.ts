/**
 * Operator missing review — metadata only on `packages.manifest_data.operator_item_scan`.
 * Physical received units live in `return_items`; missing marks never create return_items rows.
 */

import { PACKAGE_EMPTY_BOX_MANIFEST_KEY } from "@/lib/scanner/package-empty-box-manifest";

export const OPERATOR_MISSING_REVIEW_SOURCE = "operator_missing_review" as const;

export type OperatorMissingReviewEntry = {
  expected_package_id?: string | null;
  expected_line_id?: string | null;
  slip_content_id?: string | null;
  product_id?: string | null;
  resolved_product_id?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  expected_qty: number;
  scanned_qty: number;
  operator_marked_missing_qty: number;
  computed_shortage_at_mark_time: number;
  marked_by: string;
  marked_at: string;
  note?: string | null;
  source: typeof OPERATOR_MISSING_REVIEW_SOURCE;
};

export type OperatorMissingReviewConflict = {
  slip_content_id?: string | null;
  message: string;
  computed_shortage: number;
  operator_marked_missing_qty: number;
  detected_at: string;
};

export type OperatorItemScanShortageFinalizeMeta = {
  expected_qty: number;
  scanned_qty: number;
  computed_shortage: number;
  shortage_source: "system_detected" | "operator_confirmed" | "none";
  operator_missing_review_attached: boolean;
  conflicts?: OperatorMissingReviewConflict[];
};

function parseManifestObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s.startsWith("{")) return {};
    try {
      const o = JSON.parse(s) as unknown;
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function readOperatorItemScanBlock(raw: unknown): Record<string, unknown> {
  const md = parseManifestObject(raw);
  const block = md[PACKAGE_EMPTY_BOX_MANIFEST_KEY];
  if (block && typeof block === "object" && !Array.isArray(block)) {
    return { ...(block as Record<string, unknown>) };
  }
  return {};
}

function normalizeMissingReviewEntry(raw: unknown): OperatorMissingReviewEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const slipId = String(o.slip_content_id ?? o.expected_line_id ?? "").trim() || null;
  const markedQty = Math.max(0, Math.floor(Number(o.operator_marked_missing_qty ?? 0)));
  if (!slipId && markedQty <= 0) return null;
  const markedAt = String(o.marked_at ?? "").trim();
  const markedBy = String(o.marked_by ?? "").trim();
  if (!markedAt || !markedBy) return null;
  return {
    expected_package_id: String(o.expected_package_id ?? "").trim() || null,
    expected_line_id: String(o.expected_line_id ?? slipId ?? "").trim() || slipId,
    slip_content_id: slipId,
    product_id: String(o.product_id ?? "").trim() || null,
    resolved_product_id: String(o.resolved_product_id ?? "").trim() || null,
    asin: String(o.asin ?? "").trim() || null,
    fnsku: String(o.fnsku ?? "").trim() || null,
    sku: String(o.sku ?? "").trim() || null,
    expected_qty: Math.max(0, Math.floor(Number(o.expected_qty ?? 0))),
    scanned_qty: Math.max(0, Math.floor(Number(o.scanned_qty ?? 0))),
    operator_marked_missing_qty: markedQty,
    computed_shortage_at_mark_time: Math.max(0, Math.floor(Number(o.computed_shortage_at_mark_time ?? 0))),
    marked_by: markedBy,
    marked_at: markedAt,
    note: String(o.note ?? "").trim() || null,
    source: OPERATOR_MISSING_REVIEW_SOURCE,
  };
}

/** All operator missing-review entries on the package manifest. */
export function readMissingReviewEntries(raw: unknown): OperatorMissingReviewEntry[] {
  const block = readOperatorItemScanBlock(raw);
  const arr = block.missing_review;
  if (!Array.isArray(arr)) return [];
  const out: OperatorMissingReviewEntry[] = [];
  for (const item of arr) {
    const entry = normalizeMissingReviewEntry(item);
    if (entry) out.push(entry);
  }
  return out;
}

/** Recorded missing qty for one slip line from manifest; `undefined` when no manifest entry. */
export function missingReviewRecordedQtyForSlip(
  raw: unknown,
  slipContentId: string | null | undefined,
): number | undefined {
  const slipId = String(slipContentId ?? "").trim();
  if (!slipId) return undefined;
  const entry = readMissingReviewEntries(raw).find((e) => e.slip_content_id === slipId);
  if (!entry) return undefined;
  return Math.min(entry.expected_qty, entry.operator_marked_missing_qty);
}

export function buildOperatorMissingReviewEntry(args: {
  slipContentId: string;
  expectedPackageId?: string | null;
  resolvedProductId?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  expectedQty: number;
  scannedQty: number;
  additionalMissingQty: number;
  priorMarkedQty?: number;
  markedBy: string;
  markedAt: string;
  note?: string | null;
}): OperatorMissingReviewEntry {
  const expected = Math.max(0, Math.floor(args.expectedQty));
  const scanned = Math.max(0, Math.floor(args.scannedQty));
  const prior = Math.max(0, Math.floor(args.priorMarkedQty ?? 0));
  const add = Math.max(0, Math.floor(args.additionalMissingQty));
  const operatorMarked = Math.min(expected, prior + add);
  const computedShortage = Math.max(0, expected - scanned);
  return {
    expected_package_id: args.expectedPackageId ?? null,
    expected_line_id: args.slipContentId,
    slip_content_id: args.slipContentId,
    product_id: args.resolvedProductId ?? null,
    resolved_product_id: args.resolvedProductId ?? null,
    asin: args.asin ?? null,
    fnsku: args.fnsku ?? null,
    sku: args.sku ?? null,
    expected_qty: expected,
    scanned_qty: scanned,
    operator_marked_missing_qty: operatorMarked,
    computed_shortage_at_mark_time: computedShortage,
    marked_by: args.markedBy,
    marked_at: args.markedAt,
    note: args.note ?? null,
    source: OPERATOR_MISSING_REVIEW_SOURCE,
  };
}

/** Upsert missing-review entries by slip_content_id. */
export function mergePackageManifestMissingReview(
  existingManifest: unknown,
  newEntries: OperatorMissingReviewEntry[],
): Record<string, unknown> {
  const md = parseManifestObject(existingManifest);
  const prior = readOperatorItemScanBlock(existingManifest);
  const bySlip = new Map<string, OperatorMissingReviewEntry>();
  for (const e of readMissingReviewEntries(existingManifest)) {
    if (e.slip_content_id) bySlip.set(e.slip_content_id, e);
  }
  for (const e of newEntries) {
    if (e.slip_content_id) bySlip.set(e.slip_content_id, e);
  }
  return {
    ...md,
    [PACKAGE_EMPTY_BOX_MANIFEST_KEY]: {
      ...prior,
      missing_review: [...bySlip.values()],
    },
  };
}

export function mergePackageManifestMissingReviewConflicts(
  existingManifest: unknown,
  conflicts: OperatorMissingReviewConflict[],
): Record<string, unknown> {
  const md = parseManifestObject(existingManifest);
  const prior = readOperatorItemScanBlock(existingManifest);
  return {
    ...md,
    [PACKAGE_EMPTY_BOX_MANIFEST_KEY]: {
      ...prior,
      missing_review_conflicts: conflicts,
    },
  };
}

export function mergePackageManifestShortageFinalize(
  existingManifest: unknown,
  meta: OperatorItemScanShortageFinalizeMeta,
): Record<string, unknown> {
  const md = parseManifestObject(existingManifest);
  const prior = readOperatorItemScanBlock(existingManifest);
  return {
    ...md,
    [PACKAGE_EMPTY_BOX_MANIFEST_KEY]: {
      ...prior,
      shortage_finalize: meta,
    },
  };
}

export function detectMissingReviewConflicts(args: {
  entries: OperatorMissingReviewEntry[];
  expectedQty: number;
  scannedQty: number;
  detectedAtIso: string;
}): OperatorMissingReviewConflict[] {
  const computedShortage = Math.max(0, args.expectedQty - args.scannedQty);
  const conflicts: OperatorMissingReviewConflict[] = [];
  const totalOperatorMarked = args.entries.reduce((s, e) => s + e.operator_marked_missing_qty, 0);

  if (computedShortage === 0 && totalOperatorMarked > 0) {
    conflicts.push({
      message: "Operator marked missing but computed shortage is zero.",
      computed_shortage: computedShortage,
      operator_marked_missing_qty: totalOperatorMarked,
      detected_at: args.detectedAtIso,
    });
  }

  for (const entry of args.entries) {
    const lineShortage = Math.max(0, entry.expected_qty - entry.scanned_qty);
    if (entry.operator_marked_missing_qty > lineShortage) {
      conflicts.push({
        slip_content_id: entry.slip_content_id,
        message: `Operator marked ${entry.operator_marked_missing_qty} missing but computed shortage is ${lineShortage}.`,
        computed_shortage: lineShortage,
        operator_marked_missing_qty: entry.operator_marked_missing_qty,
        detected_at: args.detectedAtIso,
      });
    }
  }

  return conflicts;
}
