/**
 * Upload metadata slice for ImportDescriptorV1 (NEXT-IMPORT-04).
 * Stored under `raw_report_uploads.metadata.import_descriptor` — advisory only;
 * does not change sync/staging routing until explicitly wired later.
 */

import type { AmazonSyncKind } from "../pipeline/amazon-report-registry";
import { resolveAmazonImportSyncKind } from "../pipeline/amazon-report-registry";
import type { RawReportType } from "../raw-report-types";
import { mergeUploadMetadata, type RawReportUploadMetadata } from "../raw-report-upload-metadata";
import {
  getAmazonDescriptorById,
  getAmazonDescriptorByKind,
} from "./amazon-import-descriptors-v1";
import {
  IMPORT_DESCRIPTOR_VERSION,
  type ImportDescriptorV1,
  type ImportProvider,
  type ImportSourceFamily,
} from "./import-descriptor-v1";

/** JSONB key on `raw_report_uploads.metadata`. */
export const IMPORT_DESCRIPTOR_METADATA_KEY = "import_descriptor" as const;

/** Persisted / API-facing descriptor fields for an upload session. */
export type ImportUploadDescriptorMetadata = {
  descriptor_id: string;
  descriptor_version: number;
  /** Mirrors `ImportDescriptorV1.parser_profile` — header/staging hint only. */
  classify_profile: string;
  import_kind: AmazonSyncKind | null;
  source_family: ImportSourceFamily;
  provider: ImportProvider;
  /** Optional trace: rule-based matchedRule or `descriptor_id` override. */
  classification_source?: "rules" | "descriptor_id" | "report_type";
  matched_rule?: string;
};

export function isImportDescriptorMetadataEnabled(): boolean {
  const v = process.env.ENABLE_IMPORT_DESCRIPTOR_METADATA?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function buildImportUploadDescriptorMetadataFromDescriptor(
  d: ImportDescriptorV1,
  trace?: { classification_source?: ImportUploadDescriptorMetadata["classification_source"]; matched_rule?: string },
): ImportUploadDescriptorMetadata {
  return {
    descriptor_id: d.descriptor_id,
    descriptor_version: d.descriptor_version,
    classify_profile: d.parser_profile,
    import_kind: d.import_kind,
    source_family: d.source_family,
    provider: d.provider,
    classification_source: trace?.classification_source,
    matched_rule: trace?.matched_rule,
  };
}

export function buildImportUploadDescriptorMetadataFromReportType(
  reportType: RawReportType,
  trace?: { matched_rule?: string; classification_source?: ImportUploadDescriptorMetadata["classification_source"] },
): ImportUploadDescriptorMetadata | null {
  const kind = resolveAmazonImportSyncKind(reportType);
  if (kind === "UNKNOWN") return null;
  const d = getAmazonDescriptorByKind(kind);
  if (!d) return null;
  return buildImportUploadDescriptorMetadataFromDescriptor(d, {
    classification_source: trace?.classification_source ?? "report_type",
    matched_rule: trace?.matched_rule,
  });
}

export function buildImportUploadDescriptorMetadataFromDescriptorId(
  descriptorId: string,
  trace?: { matched_rule?: string },
): ImportUploadDescriptorMetadata | null {
  const d = getAmazonDescriptorById(descriptorId.trim());
  if (!d) return null;
  return buildImportUploadDescriptorMetadataFromDescriptor(d, {
    classification_source: "descriptor_id",
    matched_rule: trace?.matched_rule,
  });
}

export function readImportUploadDescriptorMetadata(
  metadata: unknown,
): ImportUploadDescriptorMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const block = (metadata as unknown as Record<string, unknown>)[IMPORT_DESCRIPTOR_METADATA_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const o = block as unknown as Record<string, unknown>;
  const descriptor_id = typeof o.descriptor_id === "string" ? o.descriptor_id.trim() : "";
  if (!descriptor_id) return null;
  const descriptor_version =
    typeof o.descriptor_version === "number" && Number.isFinite(o.descriptor_version)
      ? o.descriptor_version
      : IMPORT_DESCRIPTOR_VERSION;
  const classify_profile = typeof o.classify_profile === "string" ? o.classify_profile.trim() : "";
  const import_kind =
    typeof o.import_kind === "string" && o.import_kind.trim()
      ? (o.import_kind.trim() as AmazonSyncKind)
      : null;
  const source_family =
    typeof o.source_family === "string" && o.source_family.trim()
      ? (o.source_family.trim() as ImportSourceFamily)
      : "unknown";
  const provider =
    typeof o.provider === "string" && o.provider.trim()
      ? (o.provider.trim() as ImportProvider)
      : "amazon";
  return {
    descriptor_id,
    descriptor_version,
    classify_profile: classify_profile || "csv_headers",
    import_kind,
    source_family,
    provider,
    classification_source:
      o.classification_source === "rules" ||
      o.classification_source === "descriptor_id" ||
      o.classification_source === "report_type"
        ? o.classification_source
        : undefined,
    matched_rule: typeof o.matched_rule === "string" ? o.matched_rule : undefined,
  };
}

export function mergeImportDescriptorIntoUploadMetadata(
  prev: unknown,
  descriptor: ImportUploadDescriptorMetadata | null,
): RawReportUploadMetadata {
  if (!descriptor) return mergeUploadMetadata(prev, {});
  return mergeUploadMetadata(prev, {
    [IMPORT_DESCRIPTOR_METADATA_KEY]: descriptor,
  } as Partial<RawReportUploadMetadata>);
}

export function resolveClassifyProfileFromUploadMetadata(metadata: unknown): string | null {
  const d = readImportUploadDescriptorMetadata(metadata);
  return d?.classify_profile?.trim() || null;
}
