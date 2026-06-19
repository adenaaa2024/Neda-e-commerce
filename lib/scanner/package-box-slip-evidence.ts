/**
 * BOX packing slip OCR evidence — operator review/edit metadata on `packages.manifest_data`.
 * Stored under `box_slip_vision.operator_review`. Does not mutate shipment expected or `return_items`.
 */

import type { BoxSlipVisionLine } from "@/lib/scanner/box-slip-vision-parse";

export const BOX_SLIP_EVIDENCE_REVIEW_MANIFEST_KEY = "operator_review" as const;

export type BoxSlipEvidenceReviewStatus =
  | "detected"
  | "draft"
  | "confirmed"
  | "needs_review"
  | "unreadable";

export type BoxSlipEvidenceLineAudit = {
  original_detected?: {
    upc?: string | null;
    fnsku?: string | null;
    sku?: string | null;
    printed_asin?: string | null;
    description?: string | null;
    expected_qty?: number;
    condition?: string | null;
  };
  edited_fields?: string[];
};

export type BoxSlipEvidenceLine = {
  upc: string | null;
  fnsku: string | null;
  sku?: string | null;
  printed_asin?: string | null;
  description: string | null;
  expected_qty: number;
  condition: string | null;
  missing?: boolean;
  needs_review?: boolean;
  line_audit?: BoxSlipEvidenceLineAudit;
};

export type BoxSlipEvidenceReview = {
  status: BoxSlipEvidenceReviewStatus;
  lines: BoxSlipEvidenceLine[];
  edited_by: string | null;
  edited_at: string | null;
  confirmed_at?: string | null;
  confirmed_by?: string | null;
  /** Set when operator marks slip unreadable (manifest JSON only). */
  marked_by?: string | null;
  marked_at?: string | null;
  note?: string | null;
  original_ocr_snapshot?: BoxSlipVisionLine[];
};

export type BoxSlipEvidenceDisplay = {
  lines: BoxSlipVisionLine[];
  status: BoxSlipEvidenceReviewStatus;
  unreadable: boolean;
  source: "ocr" | "operator_review";
  review: BoxSlipEvidenceReview | null;
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

function normStr(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

function normQty(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function normStatus(v: unknown): BoxSlipEvidenceReviewStatus {
  const s = String(v ?? "").trim().toLowerCase();
  if (
    s === "draft" ||
    s === "confirmed" ||
    s === "needs_review" ||
    s === "unreadable" ||
    s === "detected"
  ) {
    return s;
  }
  return "detected";
}

function parseVisionLine(row: unknown): BoxSlipVisionLine | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  return {
    upc: normStr(r.upc),
    fnsku: normStr(r.fnsku),
    printed_asin: normStr(r.printed_asin),
    description: normStr(r.description),
    expected_qty: normQty(r.expected_qty ?? r.qty ?? r.quantity),
    condition: normStr(r.condition),
    missing: r.missing === true,
  };
}

function parseEvidenceLine(row: unknown): BoxSlipEvidenceLine | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const auditRaw = r.line_audit;
  let line_audit: BoxSlipEvidenceLineAudit | undefined;
  if (auditRaw && typeof auditRaw === "object" && !Array.isArray(auditRaw)) {
    const a = auditRaw as Record<string, unknown>;
    const orig = a.original_detected;
    line_audit = {
      ...(orig && typeof orig === "object" && !Array.isArray(orig)
        ? { original_detected: orig as BoxSlipEvidenceLineAudit["original_detected"] }
        : {}),
      ...(Array.isArray(a.edited_fields)
        ? { edited_fields: a.edited_fields.map((f) => String(f ?? "").trim()).filter(Boolean) }
        : {}),
    };
  }
  return {
    upc: normStr(r.upc),
    fnsku: normStr(r.fnsku),
    sku: normStr(r.sku),
    printed_asin: normStr(r.printed_asin),
    description: normStr(r.description),
    expected_qty: normQty(r.expected_qty ?? r.qty ?? r.quantity),
    condition: normStr(r.condition),
    missing: r.missing === true,
    needs_review: r.needs_review === true,
    ...(line_audit ? { line_audit } : {}),
  };
}

export function cloneBoxSlipEvidenceLines(lines: BoxSlipEvidenceLine[]): BoxSlipEvidenceLine[] {
  return lines.map((line) => ({
    upc: normStr(line.upc),
    fnsku: normStr(line.fnsku),
    sku: normStr(line.sku),
    printed_asin: normStr(line.printed_asin),
    description: normStr(line.description),
    expected_qty: normQty(line.expected_qty),
    condition: normStr(line.condition),
    missing: Boolean(line.missing),
    needs_review: Boolean(line.needs_review),
    ...(line.line_audit ? { line_audit: { ...line.line_audit } } : {}),
  }));
}

export function visionLineToEvidenceLine(
  line: BoxSlipVisionLine,
  original?: BoxSlipVisionLine,
): BoxSlipEvidenceLine {
  return {
    upc: normStr(line.upc),
    fnsku: normStr(line.fnsku),
    sku: null,
    printed_asin: normStr(line.printed_asin),
    description: normStr(line.description),
    expected_qty: normQty(line.expected_qty),
    condition: normStr(line.condition),
    missing: Boolean(line.missing),
    needs_review: false,
    ...(original
      ? {
          line_audit: {
            original_detected: {
              upc: normStr(original.upc),
              fnsku: normStr(original.fnsku),
              printed_asin: normStr(original.printed_asin),
              description: normStr(original.description),
              expected_qty: normQty(original.expected_qty),
              condition: normStr(original.condition),
            },
          },
        }
      : {}),
  };
}

export function evidenceLinesFromVisionLines(lines: BoxSlipVisionLine[]): BoxSlipEvidenceLine[] {
  return lines.map((line) => visionLineToEvidenceLine(line));
}

export function evidenceLineToVisionLine(line: BoxSlipEvidenceLine): BoxSlipVisionLine {
  const sku = normStr(line.sku);
  const fnsku = normStr(line.fnsku) ?? sku;
  return {
    upc: normStr(line.upc),
    fnsku,
    printed_asin: normStr(line.printed_asin),
    description: normStr(line.description),
    expected_qty: normQty(line.expected_qty),
    condition: normStr(line.condition),
    missing: Boolean(line.missing),
  };
}

export function readBoxSlipEvidenceReview(manifestRaw: unknown): BoxSlipEvidenceReview | null {
  const md = parseManifestObject(manifestRaw);
  const box = md.box_slip_vision;
  if (!box || typeof box !== "object" || Array.isArray(box)) return null;
  const reviewRaw = (box as Record<string, unknown>)[BOX_SLIP_EVIDENCE_REVIEW_MANIFEST_KEY];
  if (!reviewRaw || typeof reviewRaw !== "object" || Array.isArray(reviewRaw)) return null;
  const r = reviewRaw as Record<string, unknown>;
  const linesIn = Array.isArray(r.lines) ? r.lines : [];
  const lines = linesIn.map(parseEvidenceLine).filter((l): l is BoxSlipEvidenceLine => l != null);
  const ocrIn = Array.isArray(r.original_ocr_snapshot) ? r.original_ocr_snapshot : [];
  const original_ocr_snapshot = ocrIn
    .map(parseVisionLine)
    .filter((l): l is BoxSlipVisionLine => l != null);
  return {
    status: normStatus(r.status),
    lines: cloneBoxSlipEvidenceLines(lines),
    edited_by: normStr(r.edited_by),
    edited_at: normStr(r.edited_at),
    confirmed_at: normStr(r.confirmed_at),
    confirmed_by: normStr(r.confirmed_by),
    marked_by: normStr(r.marked_by),
    marked_at: normStr(r.marked_at),
    note: normStr(r.note),
    ...(original_ocr_snapshot.length ? { original_ocr_snapshot } : {}),
  };
}

export function boxSlipEvidenceReviewIsUnreadable(review: BoxSlipEvidenceReview | null): boolean {
  return review?.status === "unreadable";
}

export function resolveBoxSlipEvidenceDisplay(
  ocrLines: BoxSlipVisionLine[],
  review: BoxSlipEvidenceReview | null,
): BoxSlipEvidenceDisplay {
  if (review?.status === "unreadable") {
    return {
      lines: [],
      status: "unreadable",
      unreadable: true,
      source: "operator_review",
      review,
    };
  }
  if (review && review.lines.length > 0 && review.status !== "detected") {
    return {
      lines: review.lines.map(evidenceLineToVisionLine),
      status: review.status,
      unreadable: false,
      source: "operator_review",
      review,
    };
  }
  return {
    lines: ocrLines,
    status: review?.status ?? "detected",
    unreadable: false,
    source: "ocr",
    review,
  };
}

function diffEditedFields(
  next: BoxSlipEvidenceLine,
  original: BoxSlipEvidenceLineAudit["original_detected"] | undefined,
): string[] {
  if (!original) return [];
  const fields: Array<keyof NonNullable<BoxSlipEvidenceLineAudit["original_detected"]>> = [
    "upc",
    "fnsku",
    "sku",
    "printed_asin",
    "description",
    "expected_qty",
    "condition",
  ];
  const edited: string[] = [];
  for (const f of fields) {
    const a = f === "expected_qty" ? normQty(original[f]) : normStr(original[f as keyof typeof original]);
    const b =
      f === "expected_qty"
        ? normQty(next[f as keyof BoxSlipEvidenceLine])
        : normStr(next[f as keyof BoxSlipEvidenceLine]);
    if (a !== b) edited.push(f);
  }
  if (next.needs_review) edited.push("needs_review");
  return edited;
}

/** Attach per-line audit metadata when operator edits OCR lines. */
export function buildEvidenceLinesWithAudit(
  nextLines: BoxSlipEvidenceLine[],
  ocrSnapshot: BoxSlipVisionLine[],
  priorLines: BoxSlipEvidenceLine[],
): BoxSlipEvidenceLine[] {
  return nextLines.map((line, i) => {
    const ocrOrig = ocrSnapshot[i] ?? null;
    const prior = priorLines[i] ?? null;
    const original_detected =
      prior?.line_audit?.original_detected ??
      (ocrOrig
        ? {
            upc: normStr(ocrOrig.upc),
            fnsku: normStr(ocrOrig.fnsku),
            printed_asin: normStr(ocrOrig.printed_asin),
            description: normStr(ocrOrig.description),
            expected_qty: normQty(ocrOrig.expected_qty),
            condition: normStr(ocrOrig.condition),
          }
        : undefined);
    const edited_fields = diffEditedFields(line, original_detected);
    const hasAudit = original_detected || edited_fields.length > 0 || line.needs_review;
    return {
      ...line,
      ...(hasAudit
        ? {
            line_audit: {
              ...(original_detected ? { original_detected } : {}),
              ...(edited_fields.length ? { edited_fields } : {}),
            },
          }
        : {}),
    };
  });
}

export function mergeBoxSlipEvidenceReview(
  existingManifest: unknown,
  review: BoxSlipEvidenceReview,
): Record<string, unknown> {
  const md = parseManifestObject(existingManifest);
  const priorBox =
    md.box_slip_vision && typeof md.box_slip_vision === "object" && !Array.isArray(md.box_slip_vision)
      ? { ...(md.box_slip_vision as Record<string, unknown>) }
      : {};
  return {
    ...md,
    box_slip_vision: {
      ...priorBox,
      [BOX_SLIP_EVIDENCE_REVIEW_MANIFEST_KEY]: {
        status: review.status,
        lines: cloneBoxSlipEvidenceLines(review.lines),
        edited_by: review.edited_by,
        edited_at: review.edited_at,
        ...(review.confirmed_at ? { confirmed_at: review.confirmed_at } : {}),
        ...(review.confirmed_by ? { confirmed_by: review.confirmed_by } : {}),
        ...(review.marked_by !== undefined ? { marked_by: review.marked_by } : {}),
        ...(review.marked_at !== undefined ? { marked_at: review.marked_at } : {}),
        ...(review.note ? { note: review.note } : {}),
        ...(review.original_ocr_snapshot?.length
          ? { original_ocr_snapshot: review.original_ocr_snapshot }
          : {}),
      },
    },
  };
}
