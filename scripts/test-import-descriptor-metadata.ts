/**
 * Import upload descriptor metadata + classify hook tests (NEXT-IMPORT-04).
 * No DB, no API, no AI.
 *
 * Run: npm run test:import-descriptor-metadata
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { applyImportDescriptorClassifyHook } from "../lib/import/import-classify-profile-hook";
import {
  buildImportUploadDescriptorMetadataFromReportType,
  IMPORT_DESCRIPTOR_METADATA_KEY,
  mergeImportDescriptorIntoUploadMetadata,
  readImportUploadDescriptorMetadata,
} from "../lib/import/import-upload-descriptor-metadata";
import { classifyCsvHeadersRuleBased } from "../lib/csv-import-detected-type";
import { resolveAmazonImportSyncKind } from "../lib/pipeline/amazon-report-registry";
import type { RawReportType } from "../lib/raw-report-types";

const METADATA_FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "import-upload-descriptor-metadata");
const HEADER_FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "amazon-report-headers");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type MetadataFixture = {
  id: string;
  report_type: RawReportType;
  matched_rule?: string;
  expect: {
    descriptor_id: string;
    descriptor_version: number;
    classify_profile: string;
    import_kind: string;
    source_family: string;
    provider: string;
  };
};

function main(): void {
  let passed = 0;
  const failures: string[] = [];

  const metaFixtures = fs.readdirSync(METADATA_FIXTURE_DIR).filter((f) => f.endsWith(".json"));

  for (const name of metaFixtures) {
    const fx = JSON.parse(fs.readFileSync(path.join(METADATA_FIXTURE_DIR, name), "utf8")) as MetadataFixture;
    const built = buildImportUploadDescriptorMetadataFromReportType(fx.report_type, {
      matched_rule: fx.matched_rule,
      classification_source: "rules",
    });
    if (!built) {
      failures.push(`${fx.id}: build returned null`);
      continue;
    }
    if (built.descriptor_id !== fx.expect.descriptor_id) {
      failures.push(`${fx.id}: descriptor_id ${built.descriptor_id} !== ${fx.expect.descriptor_id}`);
      continue;
    }
    if (built.import_kind !== fx.expect.import_kind) {
      failures.push(`${fx.id}: import_kind mismatch`);
      continue;
    }
    passed++;
    console.log(`[OK]   build from report_type ${fx.report_type}`);
  }

  const merged = mergeImportDescriptorIntoUploadMetadata(
    { csv_headers: ["a"] },
    buildImportUploadDescriptorMetadataFromReportType("SETTLEMENT")!,
  );
  const roundTrip = readImportUploadDescriptorMetadata(merged);
  assert(roundTrip?.import_kind === "SETTLEMENT", "round-trip SETTLEMENT");
  assert(
    (merged as unknown as Record<string, unknown>)[IMPORT_DESCRIPTOR_METADATA_KEY] != null,
    "metadata key present",
  );
  passed++;
  console.log("[OK]   metadata merge + read round-trip");

  const reimbHeaders = JSON.parse(
    fs.readFileSync(path.join(HEADER_FIXTURE_DIR, "reimbursements.json"), "utf8"),
  ) as { headers: string[]; expect_report_type: string };
  const { reportType, matchedRule } = classifyCsvHeadersRuleBased(reimbHeaders.headers);
  const hook = applyImportDescriptorClassifyHook({
    headers: reimbHeaders.headers,
    report_type: reportType,
    matched_rule: matchedRule,
  });
  assert(hook.import_kind === "REIMBURSEMENTS", "hook kind");
  assert(hook.classify_profile === "csv_headers", "hook profile");
  assert(
    resolveAmazonImportSyncKind(reportType) === hook.import_kind,
    "hook import_kind matches resolveAmazonImportSyncKind",
  );
  passed++;
  console.log("[OK]   classify hook aligns with detector");

  const unknownHook = applyImportDescriptorClassifyHook({
    headers: ["col-a"],
    report_type: "UNKNOWN",
    matched_rule: "none",
  });
  assert(unknownHook.import_descriptor === null, "UNKNOWN has no descriptor");
  passed++;
  console.log("[OK]   UNKNOWN → null descriptor");

  if (failures.length) {
    console.error("\n--- FAILURES ---\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log(`\nDone: ${passed} checks passed.`);
}

main();
