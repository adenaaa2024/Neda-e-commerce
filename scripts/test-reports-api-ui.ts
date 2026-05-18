/**
 * Unit tests for Reports API UI helpers (NEXT-IMPORT-API-06).
 * Run: npm run test:reports-api-ui
 */

import {
  buildSourceRunUiSnapshot,
  computeNeedsResume,
  dateInputToWindowIso,
  sourceRunDisplayState,
} from "../lib/amazon/reports-api-ui";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testDateWindow(): void {
  const ok = dateInputToWindowIso("2026-01-01", "2026-01-31");
  if ("error" in ok) throw new Error("valid range");
  assert(ok.window_start.endsWith("Z"), "start iso");
  const bad = dateInputToWindowIso("2026-02-01", "2026-01-01");
  assert("error" in bad, "invalid range");
}

function testNeedsResume(): void {
  assert(computeNeedsResume("polling", false), "polling resumable");
  assert(computeNeedsResume("complete", true) === false, "complete not resumable");
  assert(computeNeedsResume("polling", true), "api flag");
  assert(sourceRunDisplayState("polling", true) === "needs_resume", "display");
}

function testSnapshotFromMetadata(): void {
  const snap = buildSourceRunUiSnapshot({
    uploadId: "00000000-0000-4000-8000-000000000099",
    metadata: {
      source_run: {
        source_run_id: "00000000-0000-4000-8000-000000000001",
        state: "polling",
        external_ids: { report_id: "RPT-1", report_document_id: null },
        attempt: { count: 2, last_error_code: null, next_retry_at: null },
        window: { start: "2026-01-01T00:00:00Z", end: "2026-01-31T23:59:59Z" },
        updated_at: "2026-05-20T12:00:00Z",
      },
    },
  });
  assert(snap?.report_id === "RPT-1", "report_id");
  assert(snap?.attempt_count === 2, "attempt");
  assert(snap?.needs_resume === true, "needs resume");
}

function main(): void {
  const tests = [
    { name: "date window", fn: testDateWindow },
    { name: "needs resume", fn: testNeedsResume },
    { name: "snapshot metadata", fn: testSnapshotFromMetadata },
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      t.fn();
      console.log(`ok ${t.name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${t.name}:`, e instanceof Error ? e.message : e);
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`\n${tests.length}/${tests.length} passed`);
}

main();
