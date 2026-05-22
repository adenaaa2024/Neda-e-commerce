/**
 * Stand-alone smoke test for NEXT-06: amazon_transactions store_id allow-list fix.
 *
 * Run:
 *   npx tsx scripts/transactions-mapper-smoketest.ts
 *
 * Asserts that `store_id` written by `mapRowToAmazonTransaction` survives
 * `packPayloadForSupabase(rows, NATIVE_COLUMNS_TRANSACTIONS)`:
 *
 *   1. mapper output has store_id === storeId.
 *   2. packed[0].store_id === storeId.
 *   3. packed[0].raw_data does NOT contain a store_id key
 *      (i.e. the value lives in the column, not in JSONB overflow).
 *   4. core invariant fields survive packing:
 *      organization_id, upload_id, source_line_hash, transaction_type,
 *      order_id, sku, amount, posted_date.
 *
 * No DB, no network, no route call.
 */

import {
  mapRowToAmazonTransaction,
  NATIVE_COLUMNS_TRANSACTIONS,
  packPayloadForSupabase,
} from "../lib/import-sync-mappers";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";

// Use header names that match TX_TYPE_ALIASES exactly (`transaction-type`)
// so the substring fallback in `pickT` does not also match the more specific
// PRICE_TYPE / ITEM_RELATED_FEE_TYPE / SHIPMENT_FEE_TYPE / PROMOTION_TYPE
// alias groups. Keep the row minimal so we exercise the store_id propagation
// without introducing noise from discriminator columns.
function makeRow(): Record<string, string> {
  return {
    "transaction-type": "Order",
    "settlement-id": "SETTLE-7",
    "order-id": "ORDER-42",
    "sku": "SKU-A",
    "posted-date": "2026-02-01T08:30:00Z",
    "amount": "9.99",
  };
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[${label}] expected ${e}, got ${a}`);
  }
}

function assertNonEmptyString(label: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[${label}] expected non-empty string, got ${String(value)}`);
  }
}

function main() {
  console.log("[smoketest] NEXT-06 — amazon_transactions store_id allow-list");

  // ── 1) mapper output retains store_id ────────────────────────────────────────
  const insert = mapRowToAmazonTransaction(makeRow(), ORG_ID, UPLOAD_ID, STORE_ID);
  if (!insert) {
    throw new Error("mapper returned null for a non-empty Order row — unexpected");
  }
  assertEqual("mapper: store_id", insert.store_id, STORE_ID);
  assertEqual("mapper: organization_id", insert.organization_id, ORG_ID);
  assertEqual("mapper: upload_id", insert.upload_id, UPLOAD_ID);

  // ── 2) packed payload keeps store_id at the root ─────────────────────────────
  const packedAll = packPayloadForSupabase(
    [insert as unknown as Record<string, unknown>],
    NATIVE_COLUMNS_TRANSACTIONS,
  );
  if (packedAll.length !== 1) {
    throw new Error(`expected packed length 1, got ${packedAll.length}`);
  }
  const packed = packedAll[0] as unknown as Record<string, unknown>;

  assertEqual("packed: store_id", packed.store_id, STORE_ID);
  assertEqual("packed: organization_id", packed.organization_id, ORG_ID);
  assertEqual("packed: upload_id", packed.upload_id, UPLOAD_ID);
  assertNonEmptyString("packed: source_line_hash", packed.source_line_hash);
  // Mapper composes transaction_type as `<base> | <discriminator parts>`; with a
  // non-empty SKU and no other discriminator columns, the result is "Order | SKU-A".
  assertEqual("packed: transaction_type", packed.transaction_type, "Order | SKU-A");
  assertEqual("packed: order_id", packed.order_id, "ORDER-42");
  assertEqual("packed: sku", packed.sku, "SKU-A");
  assertEqual("packed: amount", packed.amount, 9.99);
  assertNonEmptyString("packed: posted_date", packed.posted_date);

  // ── 3) raw_data must NOT contain store_id (proves the allow-list took effect) ─
  const rawData =
    packed.raw_data && typeof packed.raw_data === "object" && !Array.isArray(packed.raw_data)
      ? (packed.raw_data as unknown as Record<string, unknown>)
      : {};
  if (Object.prototype.hasOwnProperty.call(rawData, "store_id")) {
    throw new Error(
      `raw_data unexpectedly contains 'store_id' (= ${String(rawData.store_id)}). ` +
        `That means NATIVE_COLUMNS_TRANSACTIONS is still missing 'store_id' and ` +
        `packPayloadForSupabase is redirecting it to JSONB overflow.`,
    );
  }

  // ── 4) NATIVE_COLUMNS allow-list contract ────────────────────────────────────
  if (!NATIVE_COLUMNS_TRANSACTIONS.has("store_id")) {
    throw new Error("NATIVE_COLUMNS_TRANSACTIONS is missing 'store_id'");
  }

  // ── 5) null storeId is preserved as null at the column (sanity) ──────────────
  // Note: mapper signature requires storeId: string. We pass an empty string to
  // exercise the packing path symmetrically; we don't assert behavior here other
  // than "doesn't blow up".
  const insertEmpty = mapRowToAmazonTransaction(makeRow(), ORG_ID, UPLOAD_ID, "");
  if (insertEmpty) {
    const packedEmpty = packPayloadForSupabase(
      [insertEmpty as unknown as Record<string, unknown>],
      NATIVE_COLUMNS_TRANSACTIONS,
    )[0] as unknown as Record<string, unknown>;
    // packPayloadForSupabase keeps native keys as-is; empty string is preserved
    // (it does NOT redirect empty strings on native keys).
    assertEqual("packed empty: store_id is empty string", packedEmpty.store_id, "");
  }

  console.log("ALL NEXT-06 CHECKS PASSED");
}

try {
  main();
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
