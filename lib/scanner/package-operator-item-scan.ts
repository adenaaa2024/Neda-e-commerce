/** Phase 6D — `packages.manifest_data.operator_item_scan` contract (no new columns). */

export type PackageReceiveState = "open" | "finalized";

export type MissingReviewSlipEntry = {
  marked_missing_qty: number;
  marked_at: string;
  marked_by: string | null;
};

export type OperatorItemScanMissingReview = {
  by_slip_content_id: Record<string, MissingReviewSlipEntry>;
  bulk_remaining_marked_at: string | null;
  bulk_remaining_marked_by: string | null;
};

export type OperatorItemScanManifest = {
  receive_state: PackageReceiveState;
  finalized_at: string | null;
  finalized_by: string | null;
  finalize_revision: number;
  empty_box_marked: boolean;
  missing_review: OperatorItemScanMissingReview;
};

export const PACKAGE_RECEIVE_FINALIZED_EDIT_ERROR =
  "Package item receive is finalized — reopen for correction before editing scans or missing review.";

export const PACKAGE_EMPTY_BOX_SCANNED_BLOCKED_ERROR =
  "Empty box cannot be marked when scanned quantity is greater than zero.";

function asObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function parseMissingReview(raw: unknown): OperatorItemScanMissingReview {
  const base: OperatorItemScanMissingReview = {
    by_slip_content_id: {},
    bulk_remaining_marked_at: null,
    bulk_remaining_marked_by: null,
  };
  const obj = asObject(raw);
  if (!obj) return base;

  const bySlip = asObject(obj.by_slip_content_id);
  if (bySlip) {
    for (const [key, val] of Object.entries(bySlip)) {
      const entry = asObject(val);
      if (!entry) continue;
      const qty = Math.max(0, Math.floor(Number(entry.marked_missing_qty ?? 0)));
      const markedAt = String(entry.marked_at ?? "").trim();
      if (!markedAt || qty <= 0) continue;
      base.by_slip_content_id[key] = {
        marked_missing_qty: qty,
        marked_at: markedAt,
        marked_by: entry.marked_by != null ? String(entry.marked_by) : null,
      };
    }
  }

  const bulkAt = obj.bulk_remaining_marked_at;
  if (bulkAt != null && String(bulkAt).trim()) {
    base.bulk_remaining_marked_at = String(bulkAt);
    base.bulk_remaining_marked_by =
      obj.bulk_remaining_marked_by != null ? String(obj.bulk_remaining_marked_by) : null;
  }

  return base;
}

/** Parse `manifest_data.operator_item_scan` with open-package defaults. */
export function parseOperatorItemScanFromManifestData(manifestData: unknown): OperatorItemScanManifest {
  const root = asObject(manifestData);
  const ois = asObject(root?.operator_item_scan);
  const receiveState =
    String(ois?.receive_state ?? "open").trim().toLowerCase() === "finalized" ? "finalized" : "open";
  const revisionRaw = Number(ois?.finalize_revision ?? 0);
  const finalize_revision = Number.isFinite(revisionRaw) ? Math.max(0, Math.floor(revisionRaw)) : 0;

  return {
    receive_state: receiveState,
    finalized_at: ois?.finalized_at != null ? String(ois.finalized_at) : null,
    finalized_by: ois?.finalized_by != null ? String(ois.finalized_by) : null,
    finalize_revision,
    empty_box_marked: ois?.empty_box_marked === true,
    missing_review: parseMissingReview(ois?.missing_review),
  };
}

export function isPackageReceiveFinalized(manifest: OperatorItemScanManifest): boolean {
  return manifest.receive_state === "finalized";
}
