/**
 * Settlement listReports window clamp + chunk helpers.
 * Run: npm run test:reports-api-settlement-list-window
 */
import {
  clampSettlementListWindow,
  chunkDateWindow,
  settlementListWindowSpanDays,
  SETTLEMENT_LIST_REPORTS_MAX_WINDOW_DAYS,
} from "../lib/amazon/reports-api-settlement-list-window";
import { buildSettlementListReportsQuery } from "../lib/amazon/reports-api-report-request";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testClampSevenMonthWindow(): void {
  const end = new Date("2026-06-13T02:45:44.885Z");
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 7);
  const window = { start: start.toISOString(), end: end.toISOString() };
  assert(settlementListWindowSpanDays(window) > SETTLEMENT_LIST_REPORTS_MAX_WINDOW_DAYS, "7mo > 90d");
  const clamped = clampSettlementListWindow(window);
  assert(
    settlementListWindowSpanDays(clamped) <= SETTLEMENT_LIST_REPORTS_MAX_WINDOW_DAYS,
    "clamped within 90d",
  );
  assert(clamped.end === window.end, "end anchored");
}

function testBuildQueryUsesClampedWindow(): void {
  const end = "2026-06-13T02:45:44.885Z";
  const start = "2025-11-13T02:45:44.885Z";
  const q = buildSettlementListReportsQuery({
    marketplaceIds: ["ATVPDKIKX0DER"],
    windowStart: start,
    windowEnd: end,
  });
  assert(q.createdUntil === end, "createdUntil");
  assert(Date.parse(q.createdSince) > Date.parse(start), "createdSince clamped forward");
  assert(Date.parse(q.createdUntil) - Date.parse(q.createdSince) <= 90 * 86_400_000 + 1000, "span <= 90d");
}

function testChunkThirtyDays(): void {
  const chunks = chunkDateWindow("2026-04-14T00:00:00.000Z", "2026-06-13T00:00:00.000Z", 30);
  assert(chunks.length >= 2, "at least 2 chunks");
  assert(chunks[0]!.start === "2026-04-14T00:00:00.000Z", "first start");
  assert(chunks[chunks.length - 1]!.end === "2026-06-13T00:00:00.000Z", "last end");
}

function main(): void {
  const tests = [
    ["clamp 7mo", testClampSevenMonthWindow],
    ["query clamp", testBuildQueryUsesClampedWindow],
    ["chunk 30d", testChunkThirtyDays],
  ] as const;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`ok ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    }
  }
  if (failed) process.exit(1);
  console.log(`\n${tests.length}/${tests.length} passed`);
}

main();
