/**
 * Stand-alone smoke test for NEXT-07: amazon_settlements store_id propagation.
 *
 * Run:
 *   npx tsx scripts/settlement-mapper-smoketest.ts
 *
 * Asserts that `mapRowToAmazonSettlement` honors the new optional
 * `importStoreId` parameter, threading it through both delegates
 * (`mapRowToAmazonSettlementTxtFlat` and `mapRowToAmazonSettlementLegacyCsv`):
 *
 *   1. flat-TXT row + valid uuid       -> output.store_id === storeId
 *   2. legacy-CSV row + valid uuid     -> output.store_id === storeId
 *   3. flat-TXT row + null             -> output.store_id === null
 *   4. flat-TXT row, param omitted     -> output.store_id === null
 *   5. legacy-CSV row + null           -> output.store_id === null
 *   6. invariants (settlement_id, amazon_line_key, posted_date / dates,
 *      total_amount / amount_total, raw_data) are unchanged across runs that
 *      differ only in the importStoreId parameter.
 *
 * No DB, no network, no route call.
 */

import {
  mapRowToAmazonSettlement,
  type AmazonSettlementInsert,
} from "../lib/import-sync-mappers";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";

// Flat-TXT branch is detected by the presence of a `settlement_start_date` key
// (see `isAmazonSettlementTxtFlatRow` in lib/import-sync-mappers.ts). Use the
// snake_case key shape that branch reads directly off the row.
function makeTxtFlatRow(): Record<string, string> {
  return {
    settlement_id: "SETTLE-TXT-1",
    settlement_start_date: "2026-01-01T00:00:00Z",
    settlement_end_date: "2026-01-15T23:59:59Z",
    deposit_date: "2026-01-16T08:00:00Z",
    total_amount: "1234.56",
    currency: "USD",
    "extra-flat-field": "kept-in-raw-data",
  };
}

// Legacy-CSV branch is the fallback; it must NOT contain `settlement_start_date`
// at the top level. Use the canonical CSV header shape so `pickT` can find the
// fields via its alias arrays.
function makeLegacyCsvRow(): Record<string, string> {
  return {
    "settlement-id": "SETTLE-CSV-1",
    "order-id": "ORDER-9",
    "sku": "SKU-A",
    "transaction-type": "Order",
    "total": "9.99",
    "deposit-date": "2026-02-01T08:30:00Z",
    "description": "Sample settlement line",
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

function pickTxtInvariants(row: AmazonSettlementInsert) {
  return {
    organization_id: row.organization_id,
    upload_id: row.upload_id,
    settlement_id: row.settlement_id,
    amazon_line_key: row.amazon_line_key,
    settlement_start_date: row.settlement_start_date ?? null,
    settlement_end_date: row.settlement_end_date ?? null,
    deposit_date: row.deposit_date ?? null,
    total_amount: row.total_amount ?? null,
    currency: row.currency ?? null,
    raw_data: row.raw_data ?? null,
  };
}

function pickCsvInvariants(row: AmazonSettlementInsert) {
  return {
    organization_id: row.organization_id,
    upload_id: row.upload_id,
    settlement_id: row.settlement_id,
    amazon_line_key: row.amazon_line_key,
    order_id: row.order_id ?? null,
    sku: row.sku ?? null,
    transaction_type: row.transaction_type ?? null,
    amount_total: row.amount_total ?? null,
    posted_date: row.posted_date ?? null,
    description: row.description ?? null,
    transaction_status: row.transaction_status ?? null,
    raw_data: row.raw_data ?? null,
  };
}

function main() {
  console.log("[smoketest] NEXT-07 — amazon_settlements store_id propagation");

  // ── 1) flat TXT + valid uuid ─────────────────────────────────────────────────
  const txtWithStore = mapRowToAmazonSettlement(makeTxtFlatRow(), ORG_ID, UPLOAD_ID, STORE_ID);
  if (!txtWithStore) throw new Error("flat-TXT mapper returned null unexpectedly");
  assertEqual("flat+uuid: store_id", txtWithStore.store_id ?? null, STORE_ID);
  assertEqual("flat+uuid: organization_id", txtWithStore.organization_id, ORG_ID);
  assertEqual("flat+uuid: upload_id", txtWithStore.upload_id, UPLOAD_ID);
  assertEqual("flat+uuid: settlement_id", txtWithStore.settlement_id, "SETTLE-TXT-1");
  assertEqual("flat+uuid: total_amount", txtWithStore.total_amount ?? null, 1234.56);
  if (typeof txtWithStore.amazon_line_key !== "string" || txtWithStore.amazon_line_key.length === 0) {
    throw new Error("flat+uuid: amazon_line_key missing/empty");
  }

  // ── 2) legacy CSV + valid uuid ───────────────────────────────────────────────
  const csvWithStore = mapRowToAmazonSettlement(makeLegacyCsvRow(), ORG_ID, UPLOAD_ID, STORE_ID);
  if (!csvWithStore) throw new Error("legacy-CSV mapper returned null unexpectedly");
  assertEqual("csv+uuid: store_id", csvWithStore.store_id ?? null, STORE_ID);
  assertEqual("csv+uuid: organization_id", csvWithStore.organization_id, ORG_ID);
  assertEqual("csv+uuid: upload_id", csvWithStore.upload_id, UPLOAD_ID);
  assertEqual("csv+uuid: settlement_id", csvWithStore.settlement_id, "SETTLE-CSV-1");
  assertEqual("csv+uuid: order_id", csvWithStore.order_id ?? null, "ORDER-9");
  assertEqual("csv+uuid: sku", csvWithStore.sku ?? null, "SKU-A");
  assertEqual("csv+uuid: amount_total", csvWithStore.amount_total ?? null, 9.99);
  if (typeof csvWithStore.amazon_line_key !== "string" || csvWithStore.amazon_line_key.length === 0) {
    throw new Error("csv+uuid: amazon_line_key missing/empty");
  }

  // ── 3) flat TXT + explicit null ──────────────────────────────────────────────
  const txtWithNull = mapRowToAmazonSettlement(makeTxtFlatRow(), ORG_ID, UPLOAD_ID, null);
  if (!txtWithNull) throw new Error("flat-TXT mapper returned null unexpectedly (null storeId run)");
  assertEqual("flat+null: store_id is null", txtWithNull.store_id ?? null, null);

  // ── 4) flat TXT, param omitted (undefined) ───────────────────────────────────
  const txtOmitted = mapRowToAmazonSettlement(makeTxtFlatRow(), ORG_ID, UPLOAD_ID);
  if (!txtOmitted) throw new Error("flat-TXT mapper returned null unexpectedly (omitted run)");
  assertEqual("flat+omitted: store_id is null", txtOmitted.store_id ?? null, null);

  // ── 5) legacy CSV + explicit null ────────────────────────────────────────────
  const csvWithNull = mapRowToAmazonSettlement(makeLegacyCsvRow(), ORG_ID, UPLOAD_ID, null);
  if (!csvWithNull) throw new Error("legacy-CSV mapper returned null unexpectedly (null storeId run)");
  assertEqual("csv+null: store_id is null", csvWithNull.store_id ?? null, null);

  // ── 6) invariants identical across runs that differ only in storeId ─────────
  assertSame("flat invariants: uuid vs null", pickTxtInvariants(txtWithStore), pickTxtInvariants(txtWithNull));
  assertSame("flat invariants: null vs omitted", pickTxtInvariants(txtWithNull), pickTxtInvariants(txtOmitted));
  assertSame("csv invariants: uuid vs null", pickCsvInvariants(csvWithStore), pickCsvInvariants(csvWithNull));

  console.log("ALL NEXT-07 CHECKS PASSED");
}

try {
  main();
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
