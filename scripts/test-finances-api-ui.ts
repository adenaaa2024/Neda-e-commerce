/**
 * Finances API archive UI helpers (ARCHIVE-04).
 * Run: npm run test:finances-api-ui
 */

import {
  buildFinancesSourceRunUiSnapshot,
  computeFinancesNeedsResume,
  dateInputToWindowIso,
  financesSourceRunDisplayState,
} from "../lib/amazon/finances-api-ui";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testNeedsResume(): void {
  assert(computeFinancesNeedsResume("polling", false), "polling resumable");
  assert(computeFinancesNeedsResume("complete", true) === false, "complete not resumable");
  assert(computeFinancesNeedsResume("failed", true) === false, "failed not resumable");
  assert(financesSourceRunDisplayState("archived", true) === "needs_resume", "display");
}

function testSnapshotCounts(): void {
  const snap = buildFinancesSourceRunUiSnapshot({
    row: {
      id: "00000000-0000-4000-8000-000000000001",
      state: "polling",
      finances_api_version: "v0",
      window_start: "2026-01-01T00:00:00Z",
      window_end: "2026-01-31T23:59:59Z",
      metadata: { phase: "list_groups" },
      attempt: { count: 1, last_error_code: null, next_retry_at: null, last_operation: "finances.listFinancialEventGroups" },
    },
    counts: { api_pages: 3, event_groups: 10, events: 42 },
  });
  assert(snap?.counts.api_pages === 3, "pages");
  assert(snap?.counts.events === 42, "events");
  assert(snap?.phase === "list_groups", "phase");
  assert(snap?.needs_resume === true, "needs resume");
}

function testDateWindow(): void {
  const ok = dateInputToWindowIso("2026-01-01", "2026-01-31");
  assert(!("error" in ok), "valid");
}

function main(): void {
  const tests = [
    ["needs resume", testNeedsResume],
    ["snapshot counts", testSnapshotCounts],
    ["date window", testDateWindow],
  ] as const;
  for (const [name, fn] of tests) {
    fn();
    console.log(`  ok ${name}`);
  }
  console.log(`\n${tests.length}/${tests.length} passed`);
}

main();
