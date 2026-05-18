/**
 * Finances archive batch persist — unit/perf tests (no live Amazon, no Supabase).
 * Run: npm run test:finances-api-event-persist-batch
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  flattenFinancialEventsV0,
  extractFinancialEventsFromEventsPage,
} from "../lib/amazon/finances-api-event-flattener";
import {
  chunkArray,
  countPersistRoundTrips,
  DEFAULT_FINANCES_ARCHIVE_BATCH_SIZE,
  eventGroupRowIdMapKey,
  financesArchiveBatchSize,
  toFinancesEventInsertRow,
} from "../lib/amazon/finances-api-event-persist";
import { FINANCES_ARCHIVE_ALLOWED_TABLES } from "../lib/amazon/finances-api-allowed-tables";

const FIXTURE = join(
  process.cwd(),
  "tests/fixtures/sp-api-finances/v0/list-financial-events-by-group-page1.json",
);

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testChunkArray(): void {
  const c = chunkArray([1, 2, 3, 4, 5], 2);
  assert(c.length === 3 && c[0].length === 2 && c[2][0] === 5, "chunks");
}

function testSmokeScaleRoundTrips(): void {
  const { rowOriented, batched } = countPersistRoundTrips(20_221, DEFAULT_FINANCES_ARCHIVE_BATCH_SIZE);
  assert(rowOriented === 20_221, "row oriented");
  assert(batched === 41, "41 batches at 500");
  assert(rowOriented / batched > 400, "orders of magnitude fewer round trips");
}

async function testSimulatedLatency(): Promise<void> {
  const n = 2_000;
  const batchSize = 500;
  const perCallMs = 1;

  const rowStart = performance.now();
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, perCallMs));
  }
  const rowMs = performance.now() - rowStart;

  const batchStart = performance.now();
  const batches = Math.ceil(n / batchSize);
  for (let b = 0; b < batches; b++) {
    await new Promise((r) => setTimeout(r, perCallMs));
  }
  const batchMs = performance.now() - batchStart;

  assert(batchMs < rowMs * 0.3, `batched ${batchMs.toFixed(0)}ms vs row ${rowMs.toFixed(0)}ms`);
}

function testRowPreservesRawFragment(): void {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown as Record<string, unknown>;
  const flat = flattenFinancialEventsV0(extractFinancialEventsFromEventsPage(raw));
  const row = toFinancesEventInsertRow(
    { id: "00000000-0000-4000-8000-000000000099", organization_id: "00000000-0000-4000-8000-000000000001" },
    "00000000-0000-4000-8000-000000000002",
    "eg-111",
    flat[0]!,
  );
  assert(typeof row.raw_fragment === "object", "raw_fragment object");
  assert(row.payload_digest.length > 0, "digest");
  assert(row.reference_ids && typeof row.reference_ids === "object", "reference_ids");
  assert(
    row.organization_id === "00000000-0000-4000-8000-000000000001",
    "org scoped",
  );
}

function testIdempotencyKeyFields(): void {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown as Record<string, unknown>;
  const flat = flattenFinancialEventsV0(extractFinancialEventsFromEventsPage(raw));
  const row = toFinancesEventInsertRow(
    { id: "run-1", organization_id: "org-1" },
    "grp-row-1",
    "eg-111",
    flat[0]!,
  );
  assert(row.event_group_id === "eg-111", "group id for unique key");
  assert(row.payload_digest === flat[0]!.payload_digest, "digest for unique key");
}

function testAllowedTablesGuard(): void {
  assert(FINANCES_ARCHIVE_ALLOWED_TABLES.has("amazon_finances_events"), "events");
  assert(!FINANCES_ARCHIVE_ALLOWED_TABLES.has("financial_reference_resolver"), "no frr");
}

function testEventGroupRowIdMapKey(): void {
  const k = eventGroupRowIdMapKey("eg-1", "digest-abc");
  assert(k.includes("eg-1"), "key contains group");
}

function testBatchSizeEnvDefault(): void {
  const prev = process.env.FINANCES_ARCHIVE_BATCH_SIZE;
  delete process.env.FINANCES_ARCHIVE_BATCH_SIZE;
  assert(financesArchiveBatchSize() === DEFAULT_FINANCES_ARCHIVE_BATCH_SIZE, "default 500");
  if (prev !== undefined) process.env.FINANCES_ARCHIVE_BATCH_SIZE = prev;
}

/** Mirrors persistFlattenedEvents streaming flush (ARCHIVE-06). */
function testStreamingFlushBatchCount(): void {
  const batchSize = DEFAULT_FINANCES_ARCHIVE_BATCH_SIZE;
  const n = 20_221;
  let pending = 0;
  let batches = 0;
  for (let i = 0; i < n; i++) {
    pending++;
    if (pending >= batchSize) {
      batches++;
      pending = 0;
    }
  }
  if (pending > 0) batches++;
  assert(batches === 41, `streaming flush batches=${batches}`);
}

async function main(): Promise<void> {
  const tests: [string, () => void | Promise<void>][] = [
    ["chunk array", testChunkArray],
    ["smoke scale round trips", testSmokeScaleRoundTrips],
    ["simulated latency", testSimulatedLatency],
    ["raw fragment preserved", testRowPreservesRawFragment],
    ["idempotency key fields", testIdempotencyKeyFields],
    ["allowed tables guard", testAllowedTablesGuard],
    ["event group row id map key", testEventGroupRowIdMapKey],
    ["batch size default", testBatchSizeEnvDefault],
    ["streaming flush batch count", testStreamingFlushBatchCount],
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`\n${tests.length}/${tests.length} passed`);
}

main();
