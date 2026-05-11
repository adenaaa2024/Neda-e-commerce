/**
 * Stand-alone smoke test for NEXT-04: Reports Repository store_id propagation.
 *
 * Run:
 *   npx tsx scripts/reports-repository-mapper-smoketest.ts
 *
 * Asserts the mapper `mapRowToAmazonReportsRepository` honors the optional
 * `importStoreId` parameter:
 *
 *   1. valid uuid -> output.store_id === that uuid
 *   2. null       -> output.store_id === null
 *   3. undefined  -> output.store_id === null   (param omitted at call site)
 *   4. existing fields (transaction_type, total_amount, source_line_hash,
 *      raw_data, organization_id, upload_id) are unchanged across runs.
 *
 * No DB, no network, no route call.
 */

import {
  mapRowToAmazonReportsRepository,
  NATIVE_COLUMNS_REPORTS_REPOSITORY,
  type AmazonReportsRepositoryInsert,
} from "../lib/import-sync-mappers";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";

function makeRow(): Record<string, string> {
  return {
    "date/time": "2026-01-15T12:34:56Z",
    "settlement-id": "SETTLE-1",
    "type": "Order",
    "order-id": "ORDER-7",
    "sku": "SKU-A",
    "description": "ACME Widget",
    "total": "12.34",
    "quantity": "1",
    "marketplace": "amazon.com",
    "fulfillment": "FBA",
    "product-sales": "10.00",
    "product-sales-tax": "0.50",
    "fba-fees": "-1.20",
    "selling-fees": "-1.00",
    "transaction-status": "Released",
  };
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[${label}] expected ${e}, got ${a}`);
  }
}

function assertSame<T>(label: string, a: T, b: T): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`[${label}] values differ across runs:\n  a=${JSON.stringify(a)}\n  b=${JSON.stringify(b)}`);
  }
}

function pickInvariants(row: AmazonReportsRepositoryInsert) {
  return {
    organization_id: row.organization_id,
    upload_id: row.upload_id,
    source_line_hash: row.source_line_hash,
    transaction_type: row.transaction_type,
    order_id: row.order_id,
    sku: row.sku,
    description: row.description,
    total_amount: row.total_amount,
    quantity: row.quantity,
    raw_data: row.raw_data,
  };
}

function main() {
  console.log("[smoketest] mapRowToAmazonReportsRepository — store_id propagation");

  // ── 1) valid uuid ────────────────────────────────────────────────────────────
  const r1 = mapRowToAmazonReportsRepository(makeRow(), ORG_ID, UPLOAD_ID, STORE_ID);
  assertEqual("uuid: store_id passthrough", r1.store_id, STORE_ID);
  assertEqual("uuid: organization_id", r1.organization_id, ORG_ID);
  assertEqual("uuid: upload_id", r1.upload_id, UPLOAD_ID);
  assertEqual("uuid: transaction_type", r1.transaction_type, "Order");
  assertEqual("uuid: total_amount", r1.total_amount, 12.34);
  if (typeof r1.source_line_hash !== "string" || r1.source_line_hash.length === 0) {
    throw new Error(`uuid: source_line_hash missing or empty: ${String(r1.source_line_hash)}`);
  }

  // ── 2) explicit null ─────────────────────────────────────────────────────────
  const r2 = mapRowToAmazonReportsRepository(makeRow(), ORG_ID, UPLOAD_ID, null);
  assertEqual("null: store_id is null", r2.store_id, null);

  // ── 3) param omitted (undefined) ─────────────────────────────────────────────
  const r3 = mapRowToAmazonReportsRepository(makeRow(), ORG_ID, UPLOAD_ID);
  assertEqual("omitted: store_id is null", r3.store_id, null);

  // ── 4) invariants identical across runs (only store_id should differ) ────────
  assertSame("invariants r1 vs r2", pickInvariants(r1), pickInvariants(r2));
  assertSame("invariants r2 vs r3", pickInvariants(r2), pickInvariants(r3));

  // ── 5) NATIVE_COLUMNS contains store_id (should be allow-listed) ─────────────
  if (!NATIVE_COLUMNS_REPORTS_REPOSITORY.has("store_id")) {
    throw new Error("NATIVE_COLUMNS_REPORTS_REPOSITORY is missing 'store_id'");
  }

  // ── 6) raw_data must NOT contain a store_id key (the row had no store input) ─
  if (r1.raw_data && Object.prototype.hasOwnProperty.call(r1.raw_data, "store_id")) {
    throw new Error("raw_data unexpectedly contains 'store_id' key");
  }

  console.log("ALL NEXT-04 MAPPER CHECKS PASSED");
}

try {
  main();
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
