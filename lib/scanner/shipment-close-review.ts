/**
 * Phase 6E — Shipment close review model (unified review engine shipment scope → finalize gate UI).
 */

import {
  resolveCloseReviewIdentifiers,
  resolveCloseReviewLineTitle,
} from "@/lib/scanner/close-review-line-display";
import type { PalletShipmentReviewPreview } from "@/lib/scanner/pallet-shipment-review-types";
import type { UnifiedReviewBucket } from "@/lib/scanner/review-engine/review-engine-types";

export type ShipmentCloseReviewBucketKey = UnifiedReviewBucket | "damaged_or_problem_items";

export type ShipmentCloseReviewLineSummary = {
  lineKey: string;
  label: string;
  title: string;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  qty: number;
  detail: string | null;
};

export type ShipmentCloseReviewBucket = {
  key: ShipmentCloseReviewBucketKey;
  title: string;
  count: number;
  lines: ShipmentCloseReviewLineSummary[];
};

export type ShipmentCloseReviewModel = {
  tracking_number: string | null;
  tracking_numbers: string[];
  package_count: number;
  pallet_count: number;
  totals: {
    expected_qty: number;
    received_qty: number;
    missing_qty: number;
    over_qty: number;
    unexpected_qty: number;
    marked_missing_qty: number;
    final_shortage_qty: number;
  };
  buckets: ShipmentCloseReviewBucket[];
  bucket_counts: Record<ShipmentCloseReviewBucketKey, number>;
  has_critical_issues: boolean;
  critical_issue_labels: string[];
};

export type ShipmentCloseReviewSnapshot = {
  confirmed_at: string;
  confirmed_by: string | null;
  tracking_number: string;
  store_id: string;
  bucket_counts: Record<ShipmentCloseReviewBucketKey, number>;
  critical_issues_acknowledged: boolean;
  audit_note: string | null;
  totals: ShipmentCloseReviewModel["totals"];
  unified_bucket_counts: Record<UnifiedReviewBucket, number>;
  scope: "shipment";
};

const BUCKET_TITLES: Record<ShipmentCloseReviewBucketKey, string> = {
  complete: "Complete",
  partial: "Partial",
  missing: "Missing / final shortage",
  over: "Over",
  unexpected: "Unexpected",
  slip_only: "Slip only",
  shipment_only: "Shipment only",
  damaged_or_problem_items: "Damaged / problem items",
};

function legacyBucketToShipmentCloseKey(
  line: PalletShipmentReviewPreview["lines"][number],
): ShipmentCloseReviewBucketKey {
  if (line.problem_item_qty > 0) return "damaged_or_problem_items";
  if (line.operator_note_missing_qty > 0) return "missing";
  if (line.bucket === "expected_under_received" && line.scanned_qty < Math.max(line.expected_qty, line.slip_qty)) {
    return line.scanned_qty <= 0 ? "missing" : "partial";
  }
  switch (line.bucket) {
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

/** Build shipment close review UI model from engine-backed shipment preview. */
export function buildShipmentCloseReviewModelFromPreview(
  preview: PalletShipmentReviewPreview,
): ShipmentCloseReviewModel {
  const bucketMap = new Map<ShipmentCloseReviewBucketKey, ShipmentCloseReviewLineSummary[]>();
  const palletIds = new Set<string>();

  for (const line of preview.lines) {
    for (const pkg of line.packages) {
      const pid = String(preview.pallet_id ?? "").trim();
      if (pid) palletIds.add(pid);
    }
    const unifiedKey = legacyBucketToShipmentCloseKey(line);
    const label = line.label?.trim() || line.grain_key;
    const ids = resolveCloseReviewIdentifiers({
      grain: line.grain,
      fnsku: line.identifiers.fnsku,
      asin: line.identifiers.asin,
      sku: line.identifiers.sku,
      label,
    });
    const title = resolveCloseReviewLineTitle({
      grain: line.grain,
      fnsku: line.identifiers.fnsku,
      asin: line.identifiers.asin,
      sku: line.identifiers.sku,
      label,
    });
    const summary: ShipmentCloseReviewLineSummary = {
      lineKey: line.grain_key,
      label,
      title,
      fnsku: ids.fnsku ?? null,
      asin: ids.asin ?? null,
      sku: ids.sku ?? null,
      qty: Math.max(line.expected_qty, line.scanned_qty, line.slip_qty, 1),
      detail:
        [
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

  const buckets: ShipmentCloseReviewBucket[] = (
    Object.keys(BUCKET_TITLES) as ShipmentCloseReviewBucketKey[]
  )
    .map((key) => ({
      key,
      title: BUCKET_TITLES[key],
      count: bucketMap.get(key)?.length ?? 0,
      lines: bucketMap.get(key) ?? [],
    }))
    .filter((b) => b.count > 0);

  const bucket_counts = {} as Record<ShipmentCloseReviewBucketKey, number>;
  for (const key of Object.keys(BUCKET_TITLES) as ShipmentCloseReviewBucketKey[]) {
    bucket_counts[key] = buckets.find((b) => b.key === key)?.count ?? 0;
  }

  const critical_issue_labels: string[] = [];
  if (bucket_counts.partial > 0) critical_issue_labels.push("Partial lines");
  if (bucket_counts.missing > 0) critical_issue_labels.push("Missing / final shortage");
  if (bucket_counts.over > 0) critical_issue_labels.push("Over lines");
  if (bucket_counts.unexpected > 0) critical_issue_labels.push("Unexpected scans");
  if (bucket_counts.slip_only > 0) critical_issue_labels.push("Slip-only evidence");
  if (bucket_counts.shipment_only > 0) critical_issue_labels.push("Shipment-only expected");
  if (bucket_counts.damaged_or_problem_items > 0) critical_issue_labels.push("Damaged / problem items");

  const finalShortageQty = preview.lines.reduce((s, l) => {
    const cap = Math.max(l.expected_qty, l.slip_qty);
    const short = Math.max(0, cap - l.scanned_qty - l.operator_note_missing_qty);
    return s + short + l.operator_note_missing_qty;
  }, 0);

  return {
    tracking_number: preview.tracking_number,
    tracking_numbers: preview.tracking_numbers,
    package_count: preview.package_count,
    pallet_count: Math.max(1, preview.pallet_id ? 1 : preview.package_count > 0 ? 1 : 0),
    totals: {
      expected_qty: preview.totals.shipment_expected_units,
      received_qty: preview.totals.scanned_units,
      missing_qty: Math.max(0, preview.totals.shipment_expected_units - preview.totals.scanned_units),
      over_qty: preview.lines.reduce(
        (s, l) =>
          s +
          (l.scanned_qty > Math.max(l.expected_qty, l.slip_qty)
            ? l.scanned_qty - Math.max(l.expected_qty, l.slip_qty)
            : 0),
        0,
      ),
      unexpected_qty: preview.totals.off_manifest_units,
      marked_missing_qty: preview.totals.operator_note_missing_units,
      final_shortage_qty: finalShortageQty,
    },
    buckets,
    bucket_counts,
    has_critical_issues: critical_issue_labels.length > 0,
    critical_issue_labels,
  };
}

export function buildShipmentCloseReviewSnapshot(
  model: ShipmentCloseReviewModel,
  args: {
    confirmedAtIso: string;
    confirmedBy: string | null;
    trackingNumber: string;
    storeId: string;
    criticalIssuesAcknowledged: boolean;
    auditNote: string | null;
  },
): ShipmentCloseReviewSnapshot {
  const emptyUnified = {
    complete: 0,
    partial: 0,
    missing: 0,
    over: 0,
    unexpected: 0,
    slip_only: 0,
    shipment_only: 0,
  } satisfies Record<UnifiedReviewBucket, number>;

  const unified_bucket_counts = { ...emptyUnified };
  for (const [key, count] of Object.entries(model.bucket_counts)) {
    if (key in unified_bucket_counts) {
      unified_bucket_counts[key as UnifiedReviewBucket] = count;
    }
  }

  return {
    confirmed_at: args.confirmedAtIso,
    confirmed_by: args.confirmedBy,
    tracking_number: args.trackingNumber,
    store_id: args.storeId,
    bucket_counts: { ...model.bucket_counts },
    critical_issues_acknowledged: args.criticalIssuesAcknowledged,
    audit_note: args.auditNote?.trim() || null,
    totals: { ...model.totals },
    unified_bucket_counts,
    scope: "shipment",
  };
}
