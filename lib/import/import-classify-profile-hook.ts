/**
 * Read-only classification hook: enriches classify-headers output with ImportDescriptorV1
 * metadata without changing report_type resolution or sync behavior.
 */

import type { RawReportType } from "../raw-report-types";
import {
  buildImportUploadDescriptorMetadataFromDescriptorId,
  buildImportUploadDescriptorMetadataFromReportType,
  type ImportUploadDescriptorMetadata,
} from "./import-upload-descriptor-metadata";

export type ImportClassifyProfileHookInput = {
  headers: string[];
  report_type: RawReportType;
  matched_rule: string;
  /** When set, overrides report_type-derived descriptor (still does not change report_type). */
  descriptor_id?: string | null;
  existing_metadata?: unknown;
};

export type ImportClassifyProfileHookResult = {
  import_descriptor: ImportUploadDescriptorMetadata | null;
  classify_profile: string | null;
  descriptor_id: string | null;
  descriptor_version: number | null;
  import_kind: ImportUploadDescriptorMetadata["import_kind"];
  source_family: ImportUploadDescriptorMetadata["source_family"] | null;
  provider: ImportUploadDescriptorMetadata["provider"] | null;
};

/**
 * Produces descriptor metadata for API responses and optional upload persistence.
 * Does not mutate headers, report_type, or column_mapping.
 */
export function applyImportDescriptorClassifyHook(
  input: ImportClassifyProfileHookInput,
): ImportClassifyProfileHookResult {
  const fromId =
    input.descriptor_id?.trim()
      ? buildImportUploadDescriptorMetadataFromDescriptorId(input.descriptor_id, {
          matched_rule: input.matched_rule,
        })
      : null;

  const fromReport =
    !fromId
      ? buildImportUploadDescriptorMetadataFromReportType(input.report_type, {
          matched_rule: input.matched_rule,
          classification_source: "rules",
        })
      : null;

  const import_descriptor = fromId ?? fromReport;

  return {
    import_descriptor,
    classify_profile: import_descriptor?.classify_profile ?? null,
    descriptor_id: import_descriptor?.descriptor_id ?? null,
    descriptor_version: import_descriptor?.descriptor_version ?? null,
    import_kind: import_descriptor?.import_kind ?? null,
    source_family: import_descriptor?.source_family ?? null,
    provider: import_descriptor?.provider ?? null,
  };
}
