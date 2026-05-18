/**
 * Client/server shared shape for classify-headers additive descriptor fields (NEXT-IMPORT-04/05).
 */

import { resolveAmazonImportSyncKind } from "../pipeline/amazon-report-registry";
import type { RawReportType } from "../raw-report-types";
import type { ImportUploadDescriptorMetadata } from "./import-upload-descriptor-metadata";
import { readImportUploadDescriptorMetadata } from "./import-upload-descriptor-metadata";

export type ClassifyHeadersSource = "memory" | "rules" | "gpt" | "rules+gpt" | "filename" | "content_sample";

/** Subset of classify-headers JSON used for descriptor UI (no column_mapping). */
export type ClassifyHeadersDescriptorPayload = {
  ok?: boolean;
  report_type?: string;
  needs_mapping?: boolean;
  rule?: string;
  source?: string;
  detected_file_type?: string;
  is_supported?: boolean;
  message?: string;
  import_descriptor?: ImportUploadDescriptorMetadata | null;
  classify_profile?: string | null;
  descriptor_id?: string | null;
  descriptor_version?: number | null;
  import_kind?: string | null;
  source_family?: string | null;
  provider?: string | null;
};

export type ImportDescriptorUiStatus =
  | "ready"
  | "needs_mapping"
  | "unsupported"
  | "unknown";

export type ImportDescriptorUiConfidence = "high" | "medium" | "low";

export type ImportDescriptorUiSummary = {
  descriptor: ImportUploadDescriptorMetadata | null;
  report_type: string;
  classification_status: ImportDescriptorUiStatus;
  classification_status_label: string;
  classification_confidence: ImportDescriptorUiConfidence;
  classification_confidence_label: string;
  classify_source: string | null;
  matched_rule: string | null;
};

const STATUS_LABELS: Record<ImportDescriptorUiStatus, string> = {
  ready: "Ready to import",
  needs_mapping: "Needs column mapping",
  unsupported: "Unsupported file type",
  unknown: "Unknown file type",
};

const CONFIDENCE_LABELS: Record<ImportDescriptorUiConfidence, string> = {
  high: "High (rule-based + descriptor match)",
  medium: "Medium (heuristic / memory)",
  low: "Low (AI or incomplete descriptor)",
};

export function resolveImportDescriptorUiStatus(params: {
  reportType: string;
  needsMapping?: boolean;
  isSupported?: boolean;
}): ImportDescriptorUiStatus {
  const rt = String(params.reportType ?? "").trim();
  if (params.isSupported === false) return "unsupported";
  if (rt === "UNKNOWN" || !rt) return "unknown";
  if (params.needsMapping) return "needs_mapping";
  return "ready";
}

export function resolveImportDescriptorUiConfidence(params: {
  reportType: string;
  source?: string | null;
  descriptor: ImportUploadDescriptorMetadata | null;
}): ImportDescriptorUiConfidence {
  const rt = String(params.reportType ?? "").trim() as RawReportType;
  const src = String(params.source ?? "").trim();
  const d = params.descriptor;
  if (!d || rt === "UNKNOWN") return "low";
  const kindFromReport = resolveAmazonImportSyncKind(rt);
  const kindAligned = d.import_kind != null && d.import_kind === kindFromReport;
  if ((src === "rules" || src === "rules+gpt") && kindAligned) return "high";
  if (src === "memory" || src === "filename" || src === "content_sample") return "medium";
  if (src === "gpt") return "low";
  return kindAligned ? "medium" : "low";
}

/** Build operator-facing summary from classify-headers response (read-only). */
export function buildImportDescriptorUiSummary(
  payload: ClassifyHeadersDescriptorPayload,
): ImportDescriptorUiSummary {
  const report_type = String(payload.report_type ?? "UNKNOWN").trim();
  const descriptor =
    payload.import_descriptor ??
    (payload.descriptor_id && payload.classify_profile
      ? {
          descriptor_id: payload.descriptor_id,
          descriptor_version: payload.descriptor_version ?? 1,
          classify_profile: payload.classify_profile,
          import_kind: (payload.import_kind as ImportUploadDescriptorMetadata["import_kind"]) ?? null,
          source_family: (payload.source_family as ImportUploadDescriptorMetadata["source_family"]) ?? "unknown",
          provider: (payload.provider as ImportUploadDescriptorMetadata["provider"]) ?? "amazon",
          matched_rule: payload.rule,
          classification_source: "report_type",
        }
      : null);

  const classification_status = resolveImportDescriptorUiStatus({
    reportType: report_type,
    needsMapping: payload.needs_mapping,
    isSupported: payload.is_supported,
  });
  const classification_confidence = resolveImportDescriptorUiConfidence({
    reportType: report_type,
    source: payload.source,
    descriptor,
  });

  return {
    descriptor,
    report_type,
    classification_status,
    classification_status_label: STATUS_LABELS[classification_status],
    classification_confidence,
    classification_confidence_label: CONFIDENCE_LABELS[classification_confidence],
    classify_source: payload.source ?? null,
    matched_rule: payload.rule ?? descriptor?.matched_rule ?? null,
  };
}

/** DevTools-friendly one-line debug string (no secrets). */
/** Rebuild operator summary from persisted upload metadata (when flag was on). */
export function hydrateImportDescriptorUiSummaryFromUploadMetadata(params: {
  reportType: string;
  status?: string;
  metadata: Record<string, unknown> | null | undefined;
}): ImportDescriptorUiSummary | null {
  const report_type = String(params.reportType ?? "").trim();
  const persisted = readImportUploadDescriptorMetadata(params.metadata ?? null);
  if (!persisted && (!report_type || report_type === "UNKNOWN")) return null;
  return buildImportDescriptorUiSummary({
    report_type,
    import_descriptor: persisted,
    needs_mapping: params.status === "needs_mapping",
    is_supported: true,
  });
}

export function formatImportDescriptorDebugLog(summary: ImportDescriptorUiSummary): string {
  const d = summary.descriptor;
  return [
    "[import-descriptor]",
    `report_type=${summary.report_type}`,
    `status=${summary.classification_status}`,
    `confidence=${summary.classification_confidence}`,
    d ? `descriptor_id=${d.descriptor_id}` : "descriptor_id=null",
    d ? `import_kind=${d.import_kind ?? "null"}` : "",
    d ? `classify_profile=${d.classify_profile}` : "",
    summary.classify_source ? `source=${summary.classify_source}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
