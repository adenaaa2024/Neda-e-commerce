/**
 * Packing slip OCR operator review — audit action keys + metadata helpers.
 * Logs to `package_audit_log` (no `audit_events` schema extension required).
 */

import type { BoxSlipEvidenceLine, BoxSlipEvidenceReviewStatus } from "@/lib/scanner/package-box-slip-evidence";

export const OPERATOR_BOX_SLIP_OCR_AUDIT_ACTIONS = {
  confirmed: "operator_box_slip_ocr_confirmed",
  edit_started: "operator_box_slip_ocr_edit_started",
  edited: "operator_box_slip_ocr_edited",
  marked_unreadable: "operator_box_slip_ocr_marked_unreadable",
  unreadable_cleared: "operator_box_slip_ocr_unreadable_cleared",
} as const;

export type OperatorBoxSlipOcrAuditAction =
  (typeof OPERATOR_BOX_SLIP_OCR_AUDIT_ACTIONS)[keyof typeof OPERATOR_BOX_SLIP_OCR_AUDIT_ACTIONS];

export const BOX_SLIP_OCR_AUDIT_SOURCE = "packing_slip_ocr" as const;

export const BOX_SLIP_OCR_AUDIT_FIELD = "box_slip_vision.operator_review" as const;

const AUDIT_JSON_MAX = 4000;

export type BoxSlipOcrAuditContext = {
  package_id: string;
  organization_id: string;
  store_id?: string | null;
  package_code?: string | null;
  tracking_number?: string | null;
  line_count?: number;
  source?: typeof BOX_SLIP_OCR_AUDIT_SOURCE;
  before_status?: BoxSlipEvidenceReviewStatus | string | null;
  after_status?: BoxSlipEvidenceReviewStatus | string | null;
  changed_fields_count?: number;
  needs_review_count?: number;
  deleted_line_count?: number;
  added_line_count?: number;
  [key: string]: unknown;
};

export function serializeBoxSlipOcrAuditPayload(payload: BoxSlipOcrAuditContext): string {
  const json = JSON.stringify(payload);
  return json.length > AUDIT_JSON_MAX ? json.slice(0, AUDIT_JSON_MAX) : json;
}

function lineFingerprint(line: BoxSlipEvidenceLine): string {
  return [
    String(line.upc ?? "").trim(),
    String(line.fnsku ?? "").trim(),
    String(line.sku ?? "").trim(),
    String(line.printed_asin ?? "").trim(),
    String(line.description ?? "").trim(),
    Math.max(0, Math.floor(Number(line.expected_qty) || 0)),
    Boolean(line.needs_review),
  ].join("|");
}

/** Diff operator-edited slip lines vs prior saved review for audit metadata. */
export function computeSlipOcrEditStats(
  priorLines: BoxSlipEvidenceLine[],
  nextLines: BoxSlipEvidenceLine[],
): {
  changed_fields_count: number;
  needs_review_count: number;
  deleted_line_count: number;
  added_line_count: number;
} {
  const priorFp = new Set(priorLines.map(lineFingerprint));
  const nextFp = new Set(nextLines.map(lineFingerprint));
  let deleted = 0;
  for (const fp of priorFp) {
    if (!nextFp.has(fp)) deleted += 1;
  }
  let added = 0;
  for (const fp of nextFp) {
    if (!priorFp.has(fp)) added += 1;
  }

  let changedFields = 0;
  const max = Math.max(priorLines.length, nextLines.length);
  for (let i = 0; i < max; i += 1) {
    const a = priorLines[i];
    const b = nextLines[i];
    if (!a || !b) continue;
    if (lineFingerprint(a) !== lineFingerprint(b)) changedFields += 1;
    for (const line of [b]) {
      const auditFields = line.line_audit?.edited_fields ?? [];
      changedFields += auditFields.length;
    }
  }

  const needsReviewCount = nextLines.filter((l) => Boolean(l.needs_review)).length;

  return {
    changed_fields_count: changedFields,
    needs_review_count: needsReviewCount,
    deleted_line_count: deleted,
    added_line_count: added,
  };
}
