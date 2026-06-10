/**
 * Phase 6D — Pallet close review model (unified review engine → finalize gate UI).
 */

import type { PalletShipmentReviewPreview } from "@/lib/scanner/pallet-shipment-review-types";
import type { UnifiedReviewBucket, UnifiedReviewResult } from "@/lib/scanner/review-engine/review-engine-types";

export type PalletCloseReviewBucketKey = UnifiedReviewBucket | "damaged_or_problem_items";

export type PalletCloseReviewLineSummary = {
  lineKey: string;
  label: string;
  qty: number;
  detail: string | null;
};

export type PalletCloseReviewBucket = {
  key: PalletCloseReviewBucketKey;
  title: string;
  count: number;
  lines: PalletCloseReviewLineSummary[];
};

export type PalletCloseReviewModel = {
  pallet_id: string | null;
  tracking_number: string | null;
  package_count: number;
  totals: {
    expected_qty: number;
    received_qty: number;
    missing_qty: number;
    over_qty: number;
    unexpected_qty: number;
    marked_missing_qty: number;
  };
  buckets: PalletCloseReviewBucket[];
  bucket_counts: Record<PalletCloseReviewBucketKey, number>;
  has_critical_issues: boolean;
  critical_issue_labels: string[];
};

export type PalletCloseReviewSnapshot = {
  confirmed_at: string;
  confirmed_by: string | null;
  bucket_counts: Record<PalletCloseReviewBucketKey, number>;
  critical_issues_acknowledged: boolean;
  audit_note: string | null;
  totals: PalletCloseReviewModel["totals"];
  unified_bucket_counts: Record<UnifiedReviewBucket, number>;
  scope: "pallet";
};

const BUCKET_TITLES: Record<PalletCloseReviewBucketKey, string> = {
  complete: "Complete",
  partial: "Partial",
  missing: "Missing",
  over: "Over",
  unexpected: "Unexpected",
  slip_only: "Slip only",
  shipment_only: "Shipment only",
  damaged_or_problem_items: "Damaged / problem items",
};

function lineSummaryFromUnified(line: UnifiedReviewResult["lines"][number]): PalletCloseReviewLineSummary {
  const q = line.quantities;
  const parts: string[] = [];
  if (q.slip_qty > 0) parts.push(`slip ${q.slip_qty}`);
  if (q.shipment_expected_qty > 0) parts.push(`ship ${q.shipment_expected_qty}`);
  if (q.received_qty > 0) parts.push(`scan ${q.received_qty}`);
  if (q.marked_missing_qty > 0) parts.push(`marked missing ${q.marked_missing_qty}`);
  if (q.missing_qty > 0) parts.push(`short ${q.missing_qty}`);
  if (q.over_qty > 0) parts.push(`over ${q.over_qty}`);
  return {
    lineKey: line.grain_key,
    label: line.label?.trim() || line.grain_key,
    qty: Math.max(q.expected_qty, q.received_qty, 1),
    detail: parts.length ? parts.join(" · ") : null,
  };
}

export function buildPalletCloseReviewModel(input: {
  unified: UnifiedReviewResult;
  palletId?: string | null;
  trackingNumber?: string | null;
  packageCount?: number;
  damagedLineKeys?: string[];
}): PalletCloseReviewModel {
  const damagedKeys = new Set(input.damagedLineKeys ?? []);
  const validationBuckets: PalletCloseReviewBucket[] = (
    Object.keys(BUCKET_TITLES) as PalletCloseReviewBucketKey[]
  )
    .filter((key) => key !== "damaged_or_problem_items")
    .map((key) => {
      const lines = input.unified.lines
        .filter((line) => line.bucket === key && !damagedKeys.has(line.grain_key))
        .map(lineSummaryFromUnified);
      return {
        key,
        title: BUCKET_TITLES[key],
        count: lines.length,
        lines,
      };
    });

  const damagedLines = input.unified.lines
    .filter((line) => damagedKeys.has(line.grain_key))
    .map(lineSummaryFromUnified);
  const damagedBucket: PalletCloseReviewBucket = {
    key: "damaged_or_problem_items",
    title: BUCKET_TITLES.damaged_or_problem_items,
    count: damagedLines.length,
    lines: damagedLines,
  };

  const buckets = [...validationBuckets, damagedBucket].filter((b) => b.count > 0);

  const bucket_counts = {} as Record<PalletCloseReviewBucketKey, number>;
  for (const key of Object.keys(BUCKET_TITLES) as PalletCloseReviewBucketKey[]) {
    bucket_counts[key] = buckets.find((b) => b.key === key)?.count ?? 0;
  }

  const critical_issue_labels: string[] = [];
  if (bucket_counts.partial > 0) critical_issue_labels.push("Partial lines");
  if (bucket_counts.missing > 0) critical_issue_labels.push("Missing lines");
  if (bucket_counts.over > 0) critical_issue_labels.push("Over lines");
  if (bucket_counts.unexpected > 0) critical_issue_labels.push("Unexpected scans");
  if (bucket_counts.slip_only > 0) critical_issue_labels.push("Slip-only evidence");
  if (bucket_counts.shipment_only > 0) critical_issue_labels.push("Shipment-only expected");
  if (bucket_counts.damaged_or_problem_items > 0) critical_issue_labels.push("Damaged / problem items");

  const t = input.unified.totals;
  return {
    pallet_id: input.palletId ?? null,
    tracking_number: input.trackingNumber ?? input.unified.tracking_numbers[0] ?? null,
    package_count: input.packageCount ?? input.unified.package_ids.length,
    totals: {
      expected_qty: t.expected_qty,
      received_qty: t.received_qty,
      missing_qty: t.missing_qty,
      over_qty: t.over_qty,
      unexpected_qty: t.unexpected_qty,
      marked_missing_qty: t.marked_missing_qty,
    },
    buckets,
    bucket_counts,
    has_critical_issues: critical_issue_labels.length > 0,
    critical_issue_labels,
  };
}

export function buildPalletCloseReviewSnapshot(
  model: PalletCloseReviewModel,
  unified: UnifiedReviewResult | null,
  args: {
    confirmedAtIso: string;
    confirmedBy: string | null;
    criticalIssuesAcknowledged: boolean;
    auditNote: string | null;
  },
): PalletCloseReviewSnapshot {
  const emptyUnified = {
    complete: 0,
    partial: 0,
    missing: 0,
    over: 0,
    unexpected: 0,
    slip_only: 0,
    shipment_only: 0,
  } satisfies Record<UnifiedReviewBucket, number>;

  return {
    confirmed_at: args.confirmedAtIso,
    confirmed_by: args.confirmedBy,
    bucket_counts: { ...model.bucket_counts },
    critical_issues_acknowledged: args.criticalIssuesAcknowledged,
    audit_note: args.auditNote?.trim() || null,
    totals: { ...model.totals },
    unified_bucket_counts: unified ? { ...unified.bucket_counts } : emptyUnified,
    scope: "pallet",
  };
}

function legacyBucketToUnified(key: PalletShipmentReviewPreview["lines"][number]["bucket"]): UnifiedReviewBucket | "damaged_or_problem_items" {
  switch (key) {
    case "expected_received_complete":
      return "complete";
    case "expected_under_received":
      return "partial";
    case "expected_over_received":
      return "over";
    case "scanned_off_manifest":
      return "unexpected";
    case "slip_only_evidence":
      return "slip_only";
    case "shipment_only_expected":
      return "shipment_only";
    case "damaged_or_problem_items":
      return "damaged_or_problem_items";
    case "pending_review":
      return "partial";
    default:
      return "partial";
  }
}

/** Build close review UI model from engine-backed pallet/shipment preview (Phase 6E-A). */
export function buildPalletCloseReviewModelFromPreview(preview: PalletShipmentReviewPreview): PalletCloseReviewModel {
  const bucketMap = new Map<PalletCloseReviewBucketKey, PalletCloseReviewLineSummary[]>();

  for (const line of preview.lines) {
    const unifiedKey = legacyBucketToUnified(line.bucket);
    const summary: PalletCloseReviewLineSummary = {
      lineKey: line.grain_key,
      label: line.label?.trim() || line.grain_key,
      qty: Math.max(line.expected_qty, line.scanned_qty, line.slip_qty, 1),
      detail: [
        line.slip_qty > 0 ? `slip ${line.slip_qty}` : null,
        line.expected_qty > 0 ? `ship ${line.expected_qty}` : null,
        line.scanned_qty > 0 ? `scan ${line.scanned_qty}` : null,
        line.operator_note_missing_qty > 0 ? `marked missing ${line.operator_note_missing_qty}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
    };
    const list = bucketMap.get(unifiedKey) ?? [];
    list.push(summary);
    bucketMap.set(unifiedKey, list);
  }

  const buckets: PalletCloseReviewBucket[] = (
    Object.keys(BUCKET_TITLES) as PalletCloseReviewBucketKey[]
  )
    .map((key) => ({
      key,
      title: BUCKET_TITLES[key],
      count: bucketMap.get(key)?.length ?? 0,
      lines: bucketMap.get(key) ?? [],
    }))
    .filter((b) => b.count > 0);

  const bucket_counts = {} as Record<PalletCloseReviewBucketKey, number>;
  for (const key of Object.keys(BUCKET_TITLES) as PalletCloseReviewBucketKey[]) {
    bucket_counts[key] = buckets.find((b) => b.key === key)?.count ?? 0;
  }

  const critical_issue_labels: string[] = [];
  if (bucket_counts.partial > 0) critical_issue_labels.push("Partial lines");
  if (bucket_counts.missing > 0) critical_issue_labels.push("Missing lines");
  if (bucket_counts.over > 0) critical_issue_labels.push("Over lines");
  if (bucket_counts.unexpected > 0) critical_issue_labels.push("Unexpected scans");
  if (bucket_counts.slip_only > 0) critical_issue_labels.push("Slip-only evidence");
  if (bucket_counts.shipment_only > 0) critical_issue_labels.push("Shipment-only expected");
  if (bucket_counts.damaged_or_problem_items > 0) critical_issue_labels.push("Damaged / problem items");

  return {
    pallet_id: preview.pallet_id,
    tracking_number: preview.tracking_number,
    package_count: preview.package_count,
    totals: {
      expected_qty: preview.totals.shipment_expected_units,
      received_qty: preview.totals.scanned_units,
      missing_qty: Math.max(0, preview.totals.shipment_expected_units - preview.totals.scanned_units),
      over_qty: preview.lines.reduce(
        (s, l) => s + (l.scanned_qty > Math.max(l.expected_qty, l.slip_qty) ? l.scanned_qty - Math.max(l.expected_qty, l.slip_qty) : 0),
        0,
      ),
      unexpected_qty: preview.totals.off_manifest_units,
      marked_missing_qty: preview.totals.operator_note_missing_units,
    },
    buckets,
    bucket_counts,
    has_critical_issues: critical_issue_labels.length > 0,
    critical_issue_labels,
  };
}
