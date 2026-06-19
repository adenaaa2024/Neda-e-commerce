/**
 * Phase 6F-D — Box close review model (read-only sources → finalize gate buckets).
 * Box review consumes {@link SlipShipmentValidationPreview}, which is produced by the
 * Phase 6D unified review engine at box scope.
 */

import {
  resolveCloseReviewIdentifiers,
  resolveCloseReviewLineTitle,
} from "@/lib/scanner/close-review-line-display";
import {
  filterPackageItemDiscrepancyTags,
  ITEM_UNIT_SELLABLE_OK_TAG,
} from "@/lib/scanner/item-unit-discrepancy-tags";
import type { OperatorMissingReviewEntry } from "@/lib/scanner/package-missing-review-manifest";
import type {
  SlipShipmentValidationLine,
  SlipShipmentValidationPreview,
} from "@/lib/scanner/slip-shipment-validation-types";

export type BoxCloseReviewBucketKey =
  | "received_complete"
  | "pending_under_scanned"
  | "over_scanned"
  | "slip_only"
  | "shipment_only"
  | "scanned_off_manifest"
  | "marked_missing_operator_note"
  | "damaged_or_problem_items";

export type BoxCloseReviewLineSummary = {
  lineKey: string;
  label: string;
  title: string;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  qty: number;
  detail: string | null;
};

export type BoxCloseReviewBucket = {
  key: BoxCloseReviewBucketKey;
  title: string;
  count: number;
  lines: BoxCloseReviewLineSummary[];
};

export type BoxCloseReviewModel = {
  package_id: string | null;
  package_code: string | null;
  tracking_number: string | null;
  totals: {
    slip_units: number;
    shipment_expected_units: number;
    scanned_units: number;
    off_manifest_units: number;
  };
  buckets: BoxCloseReviewBucket[];
  bucket_counts: Record<BoxCloseReviewBucketKey, number>;
  has_critical_issues: boolean;
  critical_issue_labels: string[];
};

export type BoxCloseReviewSnapshot = {
  confirmed_at: string;
  confirmed_by: string | null;
  bucket_counts: Record<BoxCloseReviewBucketKey, number>;
  critical_issues_acknowledged: boolean;
  audit_note: string | null;
  totals: BoxCloseReviewModel["totals"];
};

const BUCKET_TITLES: Record<BoxCloseReviewBucketKey, string> = {
  received_complete: "Received complete",
  pending_under_scanned: "Pending (under-scanned)",
  over_scanned: "Over scanned",
  slip_only: "Slip only",
  shipment_only: "Shipment only",
  scanned_off_manifest: "Off manifest",
  marked_missing_operator_note: "Marked missing (operator note)",
  damaged_or_problem_items: "Damaged / problem items",
};

function lineSummaryFromValidation(line: SlipShipmentValidationLine): BoxCloseReviewLineSummary {
  const label = line.label?.trim() || line.grain_key;
  const ids = resolveCloseReviewIdentifiers({ grain: line.grain, label });
  const title = resolveCloseReviewLineTitle({ grain: line.grain, label });
  const qty = Math.max(line.scanned_qty, line.slip_qty, line.shipment_expected_qty);
  const parts: string[] = [];
  if (line.slip_qty > 0) parts.push(`slip ${line.slip_qty}`);
  if (line.shipment_expected_qty > 0) parts.push(`ship ${line.shipment_expected_qty}`);
  if (line.scanned_qty > 0) parts.push(`scan ${line.scanned_qty}`);
  if (line.recorded_missing_qty > 0) parts.push(`missing ${line.recorded_missing_qty}`);
  return {
    lineKey: line.grain_key,
    label,
    title,
    fnsku: ids.fnsku ?? null,
    asin: ids.asin ?? null,
    sku: ids.sku ?? null,
    qty,
    detail: parts.length ? parts.join(" · ") : null,
  };
}

function cell(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

function normalizeCloseReviewIdentityKey(input: {
  fnsku?: string | null;
  asin?: string | null;
  sku?: string | null;
  label?: string | null;
}): string | null {
  const fnsku = cell(input.fnsku)?.toUpperCase();
  if (fnsku) return `fnsku:${fnsku}`;
  const asin = cell(input.asin)?.toUpperCase();
  if (asin) return `asin:${asin}`;
  const sku = cell(input.sku)?.toUpperCase();
  if (sku) return `sku:${sku}`;
  const label = cell(input.label)?.toUpperCase();
  if (label) return `id:${label}`;
  return null;
}

type MarkedMissingQtyIndex = {
  bySlipId: Map<string, number>;
  byIdentity: Map<string, number>;
};

function buildMarkedMissingQtyIndex(entries: OperatorMissingReviewEntry[]): MarkedMissingQtyIndex {
  const bySlipId = new Map<string, number>();
  const byIdentity = new Map<string, number>();

  for (const entry of entries) {
    const qty = Math.max(0, Math.floor(entry.operator_marked_missing_qty));
    if (qty <= 0) continue;

    const slipId = cell(entry.slip_content_id) ?? cell(entry.expected_line_id);
    if (slipId) {
      bySlipId.set(slipId, (bySlipId.get(slipId) ?? 0) + qty);
    }

    const identityKey = normalizeCloseReviewIdentityKey({
      fnsku: entry.fnsku,
      asin: entry.asin,
      sku: entry.sku,
    });
    if (identityKey) {
      byIdentity.set(identityKey, (byIdentity.get(identityKey) ?? 0) + qty);
    }
  }

  return { bySlipId, byIdentity };
}

function markedMissingQtyForValidationLine(
  line: SlipShipmentValidationLine,
  index: MarkedMissingQtyIndex,
): number {
  let fromSlipIds = 0;
  for (const slipId of line.slip_content_ids) {
    const sid = cell(slipId);
    if (sid) fromSlipIds += index.bySlipId.get(sid) ?? 0;
  }
  if (fromSlipIds > 0) return fromSlipIds;

  const ids = resolveCloseReviewIdentifiers({ grain: line.grain, label: line.label });
  const identityKey = normalizeCloseReviewIdentityKey({
    fnsku: ids.fnsku,
    asin: ids.asin,
    sku: ids.sku,
    label: line.label,
  });
  if (identityKey) return index.byIdentity.get(identityKey) ?? 0;
  return 0;
}

/** Pending qty excludes units already marked missing by operator (mutually exclusive buckets). */
function computeUnmarkedPendingQty(
  line: SlipShipmentValidationLine,
  markedIndex: MarkedMissingQtyIndex,
): number {
  const expectedCap = Math.max(line.slip_qty, line.shipment_expected_qty);
  const shortage = Math.max(0, expectedCap - line.scanned_qty);
  const markedQty = Math.max(
    Math.floor(line.recorded_missing_qty),
    markedMissingQtyForValidationLine(line, markedIndex),
  );
  const pendingFromShortage = Math.max(0, shortage - markedQty);
  const previewRemaining = Math.max(0, Math.floor(line.remaining_missing_qty));

  if (markedQty > 0) {
    return Math.min(previewRemaining, pendingFromShortage);
  }

  return previewRemaining > 0 ? previewRemaining : pendingFromShortage;
}

function pendingLineSummaryFromValidation(
  line: SlipShipmentValidationLine,
  markedIndex: MarkedMissingQtyIndex,
): BoxCloseReviewLineSummary | null {
  const pendingQty = computeUnmarkedPendingQty(line, markedIndex);
  if (pendingQty <= 0) return null;

  const label = line.label?.trim() || line.grain_key;
  const ids = resolveCloseReviewIdentifiers({ grain: line.grain, label });
  const title = resolveCloseReviewLineTitle({ grain: line.grain, label });
  const parts: string[] = [];
  if (line.slip_qty > 0) parts.push(`slip ${line.slip_qty}`);
  if (line.shipment_expected_qty > 0) parts.push(`ship ${line.shipment_expected_qty}`);
  if (line.scanned_qty > 0) parts.push(`scan ${line.scanned_qty}`);
  if (line.recorded_missing_qty > 0) parts.push(`marked ${line.recorded_missing_qty}`);
  parts.push(`pending ${pendingQty}`);

  return {
    lineKey: line.grain_key,
    label,
    title,
    fnsku: ids.fnsku ?? null,
    asin: ids.asin ?? null,
    sku: ids.sku ?? null,
    qty: pendingQty,
    detail: parts.join(" · "),
  };
}

function bucketPendingFromValidation(
  preview: SlipShipmentValidationPreview,
  markedIndex: MarkedMissingQtyIndex,
): BoxCloseReviewBucket {
  const lines = preview.lines
    .filter((line) => line.bucket === "pending_under_scanned")
    .map((line) => pendingLineSummaryFromValidation(line, markedIndex))
    .filter((line): line is BoxCloseReviewLineSummary => line !== null);

  return {
    key: "pending_under_scanned",
    title: BUCKET_TITLES.pending_under_scanned,
    count: lines.length,
    lines,
  };
}

function bucketFromValidationLines(
  key: BoxCloseReviewBucketKey,
  preview: SlipShipmentValidationPreview,
  bucket: SlipShipmentValidationLine["bucket"],
): BoxCloseReviewBucket {
  const lines = preview.lines.filter((line) => line.bucket === bucket).map(lineSummaryFromValidation);
  return {
    key,
    title: BUCKET_TITLES[key],
    count: lines.length,
    lines,
  };
}

function isProblemPackageItem(discrepancyTags: string[] | null | undefined): boolean {
  const tags = filterPackageItemDiscrepancyTags(discrepancyTags);
  if (tags.length === 0) return false;
  return !(tags.length === 1 && tags[0] === ITEM_UNIT_SELLABLE_OK_TAG);
}

function missingReviewSummaries(
  entries: OperatorMissingReviewEntry[],
  preview: SlipShipmentValidationPreview | null,
): BoxCloseReviewLineSummary[] {
  const validationLineBySlipId = new Map<string, SlipShipmentValidationLine>();
  if (preview) {
    for (const line of preview.lines) {
      for (const slipId of line.slip_content_ids) {
        const sid = slipId?.trim();
        if (sid) validationLineBySlipId.set(sid, line);
      }
    }
  }

  return entries.map((entry, index) => {
    const slipId = entry.slip_content_id?.trim() || entry.expected_line_id?.trim() || "";
    const matchedLine = slipId ? validationLineBySlipId.get(slipId) : undefined;
    const ids = resolveCloseReviewIdentifiers({
      fnsku: entry.fnsku,
      asin: entry.asin,
      sku: entry.sku,
      grain: matchedLine?.grain ?? null,
      label: matchedLine?.label,
    });
    const label =
      ids.fnsku ||
      ids.asin ||
      ids.sku ||
      slipId ||
      "Missing review line";
    const title = resolveCloseReviewLineTitle({
      grain: matchedLine?.grain ?? null,
      label: matchedLine?.label,
      fnsku: entry.fnsku,
      asin: entry.asin,
      sku: entry.sku,
    });
    const lineKey = slipId
      ? `${slipId}:${entry.marked_at}:${entry.operator_marked_missing_qty}:${index}`
      : `missing-review:${index}:${entry.marked_at}:${entry.operator_marked_missing_qty}`;
    return {
      lineKey,
      label,
      title,
      fnsku: ids.fnsku ?? null,
      asin: ids.asin ?? null,
      sku: ids.sku ?? null,
      qty: entry.operator_marked_missing_qty,
      detail: entry.note?.trim() || null,
    };
  });
}

export function buildBoxCloseReviewModel(input: {
  preview: SlipShipmentValidationPreview | null;
  missingReviewEntries: OperatorMissingReviewEntry[];
  packageItems: Array<{ quantity: number; discrepancy_tags: string[] | null; scanned_barcode: string }>;
}): BoxCloseReviewModel {
  const preview = input.preview;
  const totals = preview?.totals ?? {
    slip_units: 0,
    shipment_expected_units: 0,
    scanned_units: 0,
    off_manifest_units: 0,
  };

  const markedMissingIndex = buildMarkedMissingQtyIndex(input.missingReviewEntries);

  const validationBuckets: BoxCloseReviewBucket[] = preview
    ? [
        bucketFromValidationLines("received_complete", preview, "shipment_and_slip_expected"),
        bucketPendingFromValidation(preview, markedMissingIndex),
        bucketFromValidationLines("over_scanned", preview, "over_scanned"),
        bucketFromValidationLines("slip_only", preview, "slip_only"),
        bucketFromValidationLines("shipment_only", preview, "shipment_only"),
        bucketFromValidationLines("scanned_off_manifest", preview, "scanned_off_manifest"),
      ]
    : [];

  const missingLines = missingReviewSummaries(input.missingReviewEntries, preview);
  const missingBucket: BoxCloseReviewBucket = {
    key: "marked_missing_operator_note",
    title: BUCKET_TITLES.marked_missing_operator_note,
    count: missingLines.length,
    lines: missingLines,
  };

  const problemItems = input.packageItems.filter((row) => isProblemPackageItem(row.discrepancy_tags));
  const problemLines: BoxCloseReviewLineSummary[] = problemItems.map((row, index) => {
    const barcode = row.scanned_barcode.trim() || "Scanned unit";
    const title = resolveCloseReviewLineTitle({ label: barcode, fnsku: barcode });
    const ids = resolveCloseReviewIdentifiers({ fnsku: barcode, label: barcode });
    return {
      lineKey: `${row.scanned_barcode.trim() || "unit"}:${index}:${filterPackageItemDiscrepancyTags(row.discrepancy_tags).join("|")}`,
      label: barcode,
      title,
      fnsku: ids.fnsku ?? null,
      asin: ids.asin ?? null,
      sku: ids.sku ?? null,
      qty: Math.max(1, Math.floor(Number(row.quantity ?? 1))),
      detail: filterPackageItemDiscrepancyTags(row.discrepancy_tags).join(", ") || null,
    };
  });
  const problemBucket: BoxCloseReviewBucket = {
    key: "damaged_or_problem_items",
    title: BUCKET_TITLES.damaged_or_problem_items,
    count: problemLines.length,
    lines: problemLines,
  };

  const buckets = [...validationBuckets, missingBucket, problemBucket].filter((b) => b.count > 0);

  const bucket_counts = {} as Record<BoxCloseReviewBucketKey, number>;
  for (const key of Object.keys(BUCKET_TITLES) as BoxCloseReviewBucketKey[]) {
    bucket_counts[key] = buckets.find((b) => b.key === key)?.count ?? 0;
  }

  const pendingQtyTotal = buckets
    .find((b) => b.key === "pending_under_scanned")
    ?.lines.reduce((sum, line) => sum + line.qty, 0) ?? 0;
  const markedMissingQtyTotal = missingLines.reduce((sum, line) => sum + line.qty, 0);

  const critical_issue_labels: string[] = [];
  if (pendingQtyTotal > 0) critical_issue_labels.push("Pending under-scanned lines");
  if (bucket_counts.over_scanned > 0) critical_issue_labels.push("Over scanned lines");
  if (bucket_counts.scanned_off_manifest > 0) critical_issue_labels.push("Off manifest scans");
  if (bucket_counts.slip_only > 0) critical_issue_labels.push("Slip-only evidence");
  if (bucket_counts.shipment_only > 0) critical_issue_labels.push("Shipment-only expected");
  if (markedMissingQtyTotal > 0 && pendingQtyTotal > 0) {
    critical_issue_labels.push("Unresolved missing quantity");
  }

  return {
    package_id: preview?.package_id ?? null,
    package_code: preview?.package_code ?? null,
    tracking_number: preview?.tracking_number ?? null,
    totals,
    buckets,
    bucket_counts,
    has_critical_issues: critical_issue_labels.length > 0,
    critical_issue_labels,
  };
}

export function buildBoxCloseReviewSnapshot(
  model: BoxCloseReviewModel,
  args: {
    confirmedAtIso: string;
    confirmedBy: string | null;
    criticalIssuesAcknowledged: boolean;
    auditNote: string | null;
  },
): BoxCloseReviewSnapshot {
  return {
    confirmed_at: args.confirmedAtIso,
    confirmed_by: args.confirmedBy,
    bucket_counts: { ...model.bucket_counts },
    critical_issues_acknowledged: args.criticalIssuesAcknowledged,
    audit_note: args.auditNote?.trim() || null,
    totals: { ...model.totals },
  };
}
