/**
 * Import classify UI summary helpers (NEXT-IMPORT-05).
 * No DB, no API, no AI.
 *
 * Run: npm run test:import-classify-response
 */

import {
  buildImportDescriptorUiSummary,
  formatImportDescriptorDebugLog,
  hydrateImportDescriptorUiSummaryFromUploadMetadata,
  resolveImportDescriptorUiConfidence,
  resolveImportDescriptorUiStatus,
} from "../lib/import/import-classify-response";
import { buildImportUploadDescriptorMetadataFromReportType } from "../lib/import/import-upload-descriptor-metadata";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main(): void {
  let passed = 0;

  assert(
    resolveImportDescriptorUiStatus({ reportType: "UNKNOWN", isSupported: true }) === "unknown",
    "UNKNOWN → unknown",
  );
  passed++;
  assert(
    resolveImportDescriptorUiStatus({ reportType: "SETTLEMENT", needsMapping: true }) === "needs_mapping",
    "needs_mapping",
  );
  passed++;

  const built = buildImportUploadDescriptorMetadataFromReportType("REIMBURSEMENTS", {
    matched_rule: "reimbursements_v1",
    classification_source: "rules",
  });
  assert(built != null, "REIMBURSEMENTS descriptor");

  const summary = buildImportDescriptorUiSummary({
    ok: true,
    report_type: "REIMBURSEMENTS",
    source: "rules",
    rule: "reimbursements_v1",
    needs_mapping: false,
    is_supported: true,
    import_descriptor: built,
    descriptor_id: built!.descriptor_id,
    descriptor_version: built!.descriptor_version,
    classify_profile: built!.classify_profile,
    import_kind: built!.import_kind,
    source_family: built!.source_family,
    provider: built!.provider,
  });
  assert(summary.classification_status === "ready", "status ready");
  assert(summary.classification_confidence === "high", "confidence high");
  assert(summary.descriptor?.descriptor_id === built!.descriptor_id, "descriptor_id");
  passed += 3;

  const log = formatImportDescriptorDebugLog(summary);
  assert(log.includes("[import-descriptor]"), "debug log prefix");
  assert(log.includes("descriptor_id="), "debug log id");
  passed += 2;

  const hydrated = hydrateImportDescriptorUiSummaryFromUploadMetadata({
    reportType: "SETTLEMENT",
    status: "mapped",
    metadata: {
      import_descriptor: buildImportUploadDescriptorMetadataFromReportType("SETTLEMENT"),
    },
  });
  assert(hydrated?.descriptor?.import_kind === "SETTLEMENT", "hydrate from metadata");
  passed++;

  const low = resolveImportDescriptorUiConfidence({
    reportType: "UNKNOWN",
    source: "gpt",
    descriptor: null,
  });
  assert(low === "low", "low confidence");
  passed++;

  console.log(`\n${passed} checks passed.`);
}

main();
