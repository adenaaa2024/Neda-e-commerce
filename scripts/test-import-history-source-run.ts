/**
 * Import History source_run helpers (NEXT-IMPORT-API-07).
 * Run: npm run test:import-history-source-run
 */

import {
  AMAZON_REPORTS_API_UPLOAD_SOURCE,
  buildImportHistorySourceRunView,
  filterImportHistoryRows,
  importHistoryOrigin,
  matchesImportHistoryFilter,
} from "../lib/amazon/import-history-source-run";
import type { RawReportUploadRow } from "../lib/raw-report-upload-row";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function row(partial: Partial<RawReportUploadRow> & { id: string }): RawReportUploadRow {
  return {
    id: partial.id,
    organization_id: partial.organization_id ?? "00000000-0000-4000-8000-000000000001",
    file_name: partial.file_name ?? "test.tsv",
    report_type: partial.report_type ?? "REIMBURSEMENTS",
    storage_prefix: null,
    status: partial.status ?? "processing",
    upload_progress: 0,
    process_progress: 0,
    uploaded_bytes: 0,
    total_bytes: 0,
    row_count: null,
    column_mapping: null,
    errorMessage: null,
    metadata: partial.metadata ?? null,
    created_by: null,
    created_at: "2026-05-20T12:00:00Z",
    updated_at: "2026-05-20T12:00:00Z",
  };
}

function testApiOrigin(): void {
  const r = row({
    id: "a",
    metadata: {
      source: AMAZON_REPORTS_API_UPLOAD_SOURCE,
      source_run: {
        source_run_id: "sr-1",
        state: "polling",
        provider: "amazon_sp_api",
        attempt: { count: 1, last_error_code: null, next_retry_at: null },
      },
    },
  });
  assert(importHistoryOrigin(r) === "api", "api origin");
  const v = buildImportHistorySourceRunView(r);
  assert(v.showSourceRunBadge, "badge shown");
  assert(v.needsResume, "polling needs resume");
}

function testManualOrigin(): void {
  const r = row({ id: "b", metadata: { storage_prefix: "x" } });
  assert(importHistoryOrigin(r) === "manual", "manual");
  assert(!buildImportHistorySourceRunView(r).showSourceRunBadge, "no badge");
}

function testFailedFilter(): void {
  const r = row({
    id: "c",
    status: "failed",
    metadata: { source_run: { source_run_id: "x", state: "failed", attempt: { count: 3 } } },
  });
  assert(matchesImportHistoryFilter(r, "failed"), "failed filter");
}

function testFilterRows(): void {
  const rows = [
    row({ id: "1", metadata: { source: AMAZON_REPORTS_API_UPLOAD_SOURCE, source_run: { source_run_id: "s", state: "complete", attempt: {} } } }),
    row({ id: "2", metadata: {} }),
  ];
  const apiOnly = filterImportHistoryRows(rows, "api", "");
  assert(apiOnly.length === 1 && apiOnly[0].id === "1", "api filter");
}

function main(): void {
  const tests = [
    ["api origin", testApiOrigin],
    ["manual origin", testManualOrigin],
    ["failed filter", testFailedFilter],
    ["filter rows", testFilterRows],
  ] as const;
  for (const [name, fn] of tests) {
    fn();
    console.log(`  ok ${name}`);
  }
  console.log(`\n${tests.length}/${tests.length} passed`);
}

main();
