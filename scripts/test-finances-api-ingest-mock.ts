/**
 * Finances API archive ingest — static/mock tests (no live Amazon).
 * Run: npm run test:finances-api-ingest-mock
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isAmazonFinancesApiIngestEnabled,
  isAmazonFinancesApiWorkerEnabled,
  financesApiDisabledReason,
} from "../lib/amazon/finances-api-worker-flags";
import { buildFinancesRunIdempotencyKey } from "../lib/amazon/finances-api-source-run";
import {
  extractFinancialEventGroupsFromListPage,
  parseFinancialEventGroupV0,
} from "../lib/amazon/finances-api-event-group-parser";
import {
  extractFinancialEventsFromEventsPage,
  flattenFinancialEventsV0,
} from "../lib/amazon/finances-api-event-flattener";
import { sha256CanonicalJson } from "../lib/amazon/finances-api-idempotency";
import { FINANCES_ARCHIVE_ALLOWED_TABLES } from "../lib/amazon/finances-api-allowed-tables";
import { financesOpListEventsByGroup } from "../lib/amazon/finances-api-page-archive";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/sp-api-finances/v0");

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testFlagsDefaultOff(): void {
  const prevW = process.env.ENABLE_AMAZON_FINANCES_API_WORKER;
  const prevI = process.env.ENABLE_AMAZON_FINANCES_API_INGEST;
  delete process.env.ENABLE_AMAZON_FINANCES_API_WORKER;
  delete process.env.ENABLE_AMAZON_FINANCES_API_INGEST;
  assert(!isAmazonFinancesApiWorkerEnabled(), "worker flag default off");
  assert(!isAmazonFinancesApiIngestEnabled(), "ingest flag default off");
  assert(financesApiDisabledReason() === "worker_disabled", "disabled reason worker");
  if (prevW !== undefined) process.env.ENABLE_AMAZON_FINANCES_API_WORKER = prevW;
  if (prevI !== undefined) process.env.ENABLE_AMAZON_FINANCES_API_INGEST = prevI;
}

function testFlagsIngestRequiresWorker(): void {
  const prevW = process.env.ENABLE_AMAZON_FINANCES_API_WORKER;
  const prevI = process.env.ENABLE_AMAZON_FINANCES_API_INGEST;
  process.env.ENABLE_AMAZON_FINANCES_API_INGEST = "true";
  delete process.env.ENABLE_AMAZON_FINANCES_API_WORKER;
  assert(!isAmazonFinancesApiIngestEnabled(), "ingest requires worker");
  process.env.ENABLE_AMAZON_FINANCES_API_WORKER = "true";
  assert(isAmazonFinancesApiIngestEnabled(), "both on enables ingest");
  if (prevW !== undefined) process.env.ENABLE_AMAZON_FINANCES_API_WORKER = prevW;
  else delete process.env.ENABLE_AMAZON_FINANCES_API_WORKER;
  if (prevI !== undefined) process.env.ENABLE_AMAZON_FINANCES_API_INGEST = prevI;
  else delete process.env.ENABLE_AMAZON_FINANCES_API_INGEST;
}

function testIdempotencyKeyStable(): void {
  const a = buildFinancesRunIdempotencyKey({
    organizationId: "00000000-0000-4000-8000-000000000001",
    storeId: "00000000-0000-4000-8000-000000000002",
    marketplaceId: "ATVPDKIKX0DER",
    windowStart: "2026-01-01T00:00:00Z",
    windowEnd: "2026-02-01T00:00:00Z",
  });
  const b = buildFinancesRunIdempotencyKey({
    organizationId: "00000000-0000-4000-8000-000000000001",
    storeId: "00000000-0000-4000-8000-000000000002",
    marketplaceId: "ATVPDKIKX0DER",
    windowStart: "2026-01-01T00:00:00Z",
    windowEnd: "2026-02-01T00:00:00Z",
  });
  assert(a === b, "idempotency stable");
  assert(/^[a-f0-9]{64}$/.test(a), "sha256 hex");
}

function testParseGroupsFromFixture(): void {
  const raw = loadJson<Record<string, unknown>>("list-financial-event-groups-page1.json");
  const groups = extractFinancialEventGroupsFromListPage(raw);
  assert(groups.length === 1, "one group");
  assert(groups[0].event_group_id === "eg-111", "group id");
  assert(groups[0].processing_status === "Closed", "status");
  const digest = sha256CanonicalJson(groups[0].raw_payload);
  assert(groups[0].payload_digest === digest, "digest matches");
}

function testFlattenEventsFromFixture(): void {
  const raw = loadJson<Record<string, unknown>>("list-financial-events-by-group-page1.json");
  const eventsObj = extractFinancialEventsFromEventsPage(raw);
  const flat = flattenFinancialEventsV0(eventsObj);
  assert(flat.length === 2, "shipment + refund");
  const shipment = flat.find((e) => e.event_type === "ShipmentEvent");
  assert(!!shipment && shipment.order_id === "111-2223333-4445555", "order id");
  assert(shipment?.amount === 12.34 && shipment.currency === "USD", "amount");
  assert(typeof shipment?.raw_fragment === "object", "raw preserved");
}

function testOperationNaming(): void {
  const op = financesOpListEventsByGroup("eg-111");
  assert(op === "finances.listFinancialEventsByGroup:eg-111", "operation suffix");
}

function testAllowedTablesOnly(): void {
  assert(FINANCES_ARCHIVE_ALLOWED_TABLES.size === 4, "four archive tables");
  assert(!FINANCES_ARCHIVE_ALLOWED_TABLES.has("financial_reference_resolver"), "no FRR");
}

function testParseGroupDirect(): void {
  const g = parseFinancialEventGroupV0({
    FinancialEventGroupId: "x",
    ProcessingStatus: "Open",
  });
  assert(g?.event_group_id === "x", "direct parse");
}

async function main(): Promise<void> {
  const tests = [
    ["flags default off", () => testFlagsDefaultOff()],
    ["flags ingest requires worker", () => testFlagsIngestRequiresWorker()],
    ["idempotency key", () => testIdempotencyKeyStable()],
    ["parse groups fixture", () => testParseGroupsFromFixture()],
    ["flatten events fixture", () => testFlattenEventsFromFixture()],
    ["operation naming", () => testOperationNaming()],
    ["allowed tables", () => testAllowedTablesOnly()],
    ["parse group direct", () => testParseGroupDirect()],
  ] as const;

  let passed = 0;
  for (const [name, fn] of tests) {
    await Promise.resolve(fn());
    console.log(`  ok ${name}`);
    passed++;
  }
  console.log(`\n${passed}/${tests.length} finances ingest mock tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
