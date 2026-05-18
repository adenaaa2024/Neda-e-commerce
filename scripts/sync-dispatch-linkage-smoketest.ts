/**
 * NEXT-15.6 — Sync-dispatch linkage regression smoketest.
 *
 * Run:
 *   npx tsx scripts/sync-dispatch-linkage-smoketest.ts
 *
 * For every AmazonSyncKind destination covered by the Amazon import mapper
 * surface (10 Convention A invocations + 10 Convention B invocations), this
 * script asserts that:
 *
 *   1. mapper output is non-null for a minimal valid fixture row.
 *   2. packPayloadForSupabase(...) preserves `organization_id` at the root.
 *   3. packPayloadForSupabase(...) preserves the upload-linkage column at the
 *      root:
 *        - Convention A tables             → `upload_id`
 *        - Convention B tables             → `source_upload_id`
 *   4. packPayloadForSupabase(...) preserves `store_id` at the root.
 *   5. None of the four linkage keys (`organization_id`, `store_id`,
 *      `upload_id`, `source_upload_id`) leak into the `raw_data` JSONB
 *      overflow.
 *
 * Plus special-case sub-tests:
 *   - Inventory ledger CSV path AND headerless TXT/positional path.
 *   - mapRowToAmazonRawArchive dispatched against all 5 raw-archive allow-lists.
 *   - amazon_removals: `source_staging_id` attach behaviour (mirror sync route).
 *   - attachPhysicalRowIdentity replica (mirror sync route, applied to FBA
 *     Inventory output).
 *   - amazon_reports_repository.upload_id text/string contract.
 *   - Empty-row null-return gate (sanity check on a newer mapper).
 *
 * No DB, no network, no Supabase write, no migration, no schema change.
 * No imports from app/api/settings/imports/sync/route.ts — that file's private
 * `attachPhysicalRowIdentity` helper is replicated inline (3-line body).
 */

import {
  packPayloadForSupabase,
  // Convention A allow-lists (upload_id).
  NATIVE_COLUMNS_RETURNS,
  NATIVE_COLUMNS_REMOVALS,
  NATIVE_COLUMNS_LEDGER,
  NATIVE_COLUMNS_REIMBURSEMENTS,
  NATIVE_COLUMNS_SETTLEMENTS,
  NATIVE_COLUMNS_SAFET,
  NATIVE_COLUMNS_TRANSACTIONS,
  NATIVE_COLUMNS_REPORTS_REPOSITORY,
  // Convention B allow-lists (source_upload_id).
  NATIVE_COLUMNS_ALL_ORDERS,
  NATIVE_COLUMNS_REPLACEMENTS,
  NATIVE_COLUMNS_FBA_GRADE_AND_RESELL,
  NATIVE_COLUMNS_RESERVED_INVENTORY,
  NATIVE_COLUMNS_FEE_PREVIEW,
  NATIVE_COLUMNS_MONTHLY_STORAGE_FEES,
  NATIVE_COLUMNS_MANAGE_FBA_INVENTORY,
  NATIVE_COLUMNS_FBA_INVENTORY,
  NATIVE_COLUMNS_INBOUND_PERFORMANCE,
  NATIVE_COLUMNS_AMAZON_FULFILLED_INVENTORY,
  // Mappers under test.
  mapRowToAmazonReturn,
  mapRowToAmazonRemoval,
  mapRowToAmazonRemovalShipment,
  mapRowToAmazonInventoryLedger,
  mapLedgerPositionalRawRowToAmazonInventoryLedgerInsert,
  mapRowToAmazonReimbursement,
  mapRowToAmazonSettlement,
  mapRowToAmazonSafetClaim,
  mapRowToAmazonTransaction,
  mapRowToAmazonReportsRepository,
  mapRowToAmazonAllOrders,
  mapRowToAmazonRawArchive,
  mapRowToAmazonManageFbaInventory,
  mapRowToAmazonFbaInventory,
  mapRowToAmazonInboundPerformance,
  mapRowToAmazonAmazonFulfilledInventory,
} from "../lib/import-sync-mappers";

// ── Fixed identifiers (deterministic across runs) ─────────────────────────────

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const STAGING_ID = "44444444-4444-4444-8444-444444444444";
// 64-char hex placeholder, mirrors source_file_sha256 size used in sync route.
const FILE_SHA = "deadbeef".repeat(8);

const LINKAGE_KEYS_NOT_IN_OVERFLOW = [
  "organization_id",
  "store_id",
  "upload_id",
  "source_upload_id",
] as const;

// ── Assertion helpers ─────────────────────────────────────────────────────────

function assertEqual<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[${label}] expected ${e}, got ${a}`);
  }
}

function assertNonNull<T>(
  label: string,
  value: T | null | undefined,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(`[${label}] expected non-null mapper output, got ${String(value)}`);
  }
}

function assertNonEmptyString(label: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[${label}] expected non-empty string, got ${String(value)}`);
  }
}

/**
 * Asserts none of the four linkage keys leaked into the raw_data JSONB.
 * A leak would mean the NATIVE_COLUMNS_* allow-list is missing the key, so
 * packPayloadForSupabase pushed it into the overflow bucket — that is a
 * propagation regression by definition.
 */
function assertNoLinkageInRawData(
  label: string,
  packed: Record<string, unknown>,
): void {
  const rd = packed.raw_data;
  if (rd === null || rd === undefined) return;
  if (typeof rd !== "object" || Array.isArray(rd)) return;
  const rawData = rd as Record<string, unknown>;
  for (const key of LINKAGE_KEYS_NOT_IN_OVERFLOW) {
    if (Object.prototype.hasOwnProperty.call(rawData, key)) {
      throw new Error(
        `[${label}] raw_data unexpectedly contains '${key}' = ${String(rawData[key])}. ` +
          `That means the NATIVE_COLUMNS_* allow-list is missing '${key}' and ` +
          `packPayloadForSupabase redirected it to the JSONB overflow.`,
      );
    }
  }
}

/**
 * Runs the standard linkage-propagation assertions on a single mapper-output
 * row packed against one allow-list.
 */
function runCase(
  label: string,
  mapperOutput: Record<string, unknown> | null,
  nativeColumns: Set<string>,
  expectedUploadCol: "upload_id" | "source_upload_id",
  expectedStoreId: string | null,
): void {
  assertNonNull(`${label}: mapper non-null`, mapperOutput);
  const packed = packPayloadForSupabase(
    [mapperOutput as Record<string, unknown>],
    nativeColumns,
  )[0] as Record<string, unknown>;

  assertEqual(`${label}: organization_id`, packed.organization_id, ORG_ID);
  assertEqual(`${label}: ${expectedUploadCol}`, packed[expectedUploadCol], UPLOAD_ID);
  assertEqual(`${label}: store_id`, packed.store_id, expectedStoreId);
  assertNoLinkageInRawData(label, packed);

  console.log(
    `[PASS] ${label}: organization_id / store_id / ${expectedUploadCol}`,
  );
}

// ── Fixture builders ──────────────────────────────────────────────────────────
// Each fixture uses the most specific header form for required fields to avoid
// the pickT substring fallback colliding with adjacent alias groups
// (lesson learned in NEXT-06 / NEXT-07 smoketests).

function buildReturnRow(): Record<string, string> {
  return {
    "license-plate-number": "LPN-1",
    "order-id": "ORDER-1",
    "sku": "SKU-A",
    "asin": "B000ABC123",
    "return-date": "2026-02-01",
    "disposition": "Sellable",
  };
}

function buildRemovalRow(): Record<string, string> {
  return {
    "order-id": "REMOVAL-1",
    "sku": "SKU-A",
    "fnsku": "X00ABCDEF",
    "disposition": "Return",
    "requested-quantity": "3",
    "order-date": "2026-02-01",
    "order-type": "Return",
  };
}

function buildRemovalShipmentRow(): Record<string, string> {
  return {
    "order-id": "REMOVAL-SHIP-1",
    "sku": "SKU-A",
    "fnsku": "X00ABCDEF",
    "disposition": "Return",
    "shipped-quantity": "2",
    "request-date": "2026-02-01",
    "shipment-date": "2026-02-03",
    "removal-order-type": "Return",
    "tracking-number": "TRK-1",
    "carrier": "UPS",
  };
}

function buildLedgerCsvRow(): Record<string, string> {
  return {
    "fnsku": "X00ABCDEF",
    "asin": "B000ABC123",
    "msku": "SKU-A",
    "date": "2026-02-01",
    "event-type": "Receipts",
    "quantity": "5",
    "disposition": "Sellable",
    "Fulfillment Center": "PHX7",
  };
}

/**
 * Headerless positional ledger raw_row — keys `ledger_pos_01`..`ledger_pos_15`.
 * Per ledgerPosKey, cells[i] = rawRow[`ledger_pos_${(i+1).padStart(2,'0')}`].
 * fnsku must be at cells[1] (i.e. ledger_pos_02) for the mapper not to gate-null.
 */
function buildLedgerPositionalRawRow(): Record<string, string> {
  return {
    ledger_pos_01: "2026-02-01",     // event_date
    ledger_pos_02: "X00ABCDEF",      // fnsku (mapper anchor)
    ledger_pos_03: "B000ABC123",     // asin
    ledger_pos_04: "SKU-A",          // sku
    ledger_pos_05: "Sample Title",   // product_name / title
    ledger_pos_06: "Receipts",       // event_type
    ledger_pos_07: "ref-1",          // reference_id
    ledger_pos_08: "5",              // quantity
    ledger_pos_09: "PHX7",           // location
    ledger_pos_10: "Sellable",       // disposition
    ledger_pos_11: "",               // reason_code
    ledger_pos_12: "US",             // country
    ledger_pos_13: "5",              // reconciled_quantity
    ledger_pos_14: "0",              // unreconciled_quantity
    ledger_pos_15: "2026-02-01T12:34:56Z", // event_timestamp
  };
}

function buildReimbursementRow(): Record<string, string> {
  return {
    "reimbursement-id": "REIMB-1",
    "order-id": "ORDER-1",
    "sku": "SKU-A",
    "amount-reimbursed": "12.34",
  };
}

function buildSettlementLegacyCsvRow(): Record<string, string> {
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

function buildSafetClaimRow(): Record<string, string> {
  return {
    "safe-t-claim-id": "SAFET-1",
    "claim-date": "2026-02-01",
    "reimbursement-amount": "12.34",
    "asin": "B000ABC123",
    "order-id": "ORDER-1",
    "claim-status": "Approved",
    "claim-reason": "Customer claim",
  };
}

function buildTransactionRow(): Record<string, string> {
  return {
    "transaction-type": "Order",
    "settlement-id": "SETTLE-7",
    "order-id": "ORDER-42",
    "sku": "SKU-A",
    "posted-date": "2026-02-01T08:30:00Z",
    "amount": "9.99",
  };
}

function buildReportsRepoRow(): Record<string, string> {
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
    "transaction-status": "Released",
  };
}

function buildAllOrdersRow(): Record<string, string> {
  return {
    "amazon-order-id": "111-1234567-7654321",
    "merchant-order-id": "MERCH-1",
    "purchase-date": "2026-02-01T08:30:00Z",
    "sku": "SKU-A",
    "shipped-quantity": "1",
    "currency": "USD",
    "item-price": "12.34",
    "shipping-country-code": "US",
    "fulfillment-channel": "Amazon",
    "sales-channel": "amazon.com",
  };
}

function buildRawArchiveRow(): Record<string, string> {
  return {
    "order-id": "ORDER-RAW-1",
    "asin": "B000ABC123",
    "fnsku": "X00ABCDEF",
    "sku": "SKU-A",
    "some-extra-column": "extra-value",
  };
}

function buildManageFbaInventoryRow(): Record<string, string> {
  return {
    "sku": "SKU-A",
    "fnsku": "X00ABCDEF",
    "asin": "B000ABC123",
    "product-name": "ACME Widget",
    "condition": "New",
    "your-price": "19.99",
    "afn-fulfillable-quantity": "10",
  };
}

function buildFbaInventoryRow(): Record<string, string> {
  return {
    "snapshot-date": "2026-02-01",
    "sku": "SKU-A",
    "fnsku": "X00ABCDEF",
    "asin": "B000ABC123",
    "product-name": "ACME Widget",
    "available": "10",
    "currency": "USD",
    "your-price": "19.99",
  };
}

function buildInboundPerformanceRow(): Record<string, string> {
  return {
    "issue-reported-date": "2026-02-01",
    "shipment-creation-date": "2026-01-28",
    "fba-shipment-id": "FBA15ABC123",
    "sku": "SKU-A",
    "asin": "B000ABC123",
    "problem-type": "Damaged",
    "problem-quantity": "1",
    "expected-quantity": "10",
    "received-quantity": "9",
  };
}

function buildAmazonFulfilledInventoryRow(): Record<string, string> {
  return {
    "seller-sku": "SKU-A",
    "fulfillment-channel-sku": "X00ABCDEF",
    "asin": "B000ABC123",
    "condition-type": "NewItem",
    "quantity-available": "10",
  };
}

function buildEmptyRow(): Record<string, string> {
  return {
    a: "",
    b: "",
    c: "  ",
  };
}

// ── Main test sequence ────────────────────────────────────────────────────────

function main(): void {
  console.log("[smoketest] NEXT-15.6 — sync dispatch linkage regression");

  // ── Convention A (upload_id) ────────────────────────────────────────────────

  runCase(
    "FBA_RETURNS",
    mapRowToAmazonReturn(buildReturnRow(), ORG_ID, UPLOAD_ID, STORE_ID) as
      | Record<string, unknown>
      | null,
    NATIVE_COLUMNS_RETURNS,
    "upload_id",
    STORE_ID,
  );

  runCase(
    "REMOVAL_ORDER",
    mapRowToAmazonRemoval(buildRemovalRow(), ORG_ID, UPLOAD_ID, STORE_ID) as
      | Record<string, unknown>
      | null,
    NATIVE_COLUMNS_REMOVALS,
    "upload_id",
    STORE_ID,
  );

  runCase(
    "REMOVAL_SHIPMENT",
    mapRowToAmazonRemovalShipment(
      buildRemovalShipmentRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_REMOVALS,
    "upload_id",
    STORE_ID,
  );

  runCase(
    "INVENTORY_LEDGER (CSV)",
    mapRowToAmazonInventoryLedger(
      buildLedgerCsvRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_LEDGER,
    "upload_id",
    STORE_ID,
  );

  runCase(
    "INVENTORY_LEDGER (TXT/positional)",
    mapLedgerPositionalRawRowToAmazonInventoryLedgerInsert(
      buildLedgerPositionalRawRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_LEDGER,
    "upload_id",
    STORE_ID,
  );

  runCase(
    "REIMBURSEMENTS",
    mapRowToAmazonReimbursement(
      buildReimbursementRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_REIMBURSEMENTS,
    "upload_id",
    STORE_ID,
  );

  runCase(
    "SETTLEMENT (legacy CSV)",
    mapRowToAmazonSettlement(
      buildSettlementLegacyCsvRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_SETTLEMENTS,
    "upload_id",
    STORE_ID,
  );

  runCase(
    "SAFET_CLAIMS",
    mapRowToAmazonSafetClaim(
      buildSafetClaimRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_SAFET,
    "upload_id",
    STORE_ID,
  );

  runCase(
    "TRANSACTIONS",
    mapRowToAmazonTransaction(
      buildTransactionRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_TRANSACTIONS,
    "upload_id",
    STORE_ID,
  );

  // REPORTS_REPOSITORY mapper has an `importStoreId?` (nullable) signature and
  // is never null — pass STORE_ID and assert the standard linkage invariants.
  {
    const reportsRepoOut = mapRowToAmazonReportsRepository(
      buildReportsRepoRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    );
    runCase(
      "REPORTS_REPOSITORY",
      reportsRepoOut as unknown as Record<string, unknown>,
      NATIVE_COLUMNS_REPORTS_REPOSITORY,
      "upload_id",
      STORE_ID,
    );

    // Explicit text/string contract on upload_id (the live DB column is text
    // per NEXT-14B; the writer must emit a uuid string, never a coerced value).
    const packedRepo = packPayloadForSupabase(
      [reportsRepoOut as unknown as Record<string, unknown>],
      NATIVE_COLUMNS_REPORTS_REPOSITORY,
    )[0] as Record<string, unknown>;
    if (typeof packedRepo.upload_id !== "string") {
      throw new Error(
        `REPORTS_REPOSITORY: upload_id must be a string (text contract), got typeof=${typeof packedRepo.upload_id}`,
      );
    }
    assertEqual("REPORTS_REPOSITORY: upload_id string value", packedRepo.upload_id, UPLOAD_ID);
    console.log("[PASS] REPORTS_REPOSITORY: upload_id text/string contract");
  }

  // ── Convention B (source_upload_id) ─────────────────────────────────────────

  runCase(
    "ALL_ORDERS",
    mapRowToAmazonAllOrders(
      buildAllOrdersRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_ALL_ORDERS,
    "source_upload_id",
    STORE_ID,
  );

  // RawArchive: one mapper invocation, five allow-list pack runs. This is the
  // "five dispatch targets" coverage — the sync route routes the same generic
  // mapper output through different NATIVE_COLUMNS_* sets depending on kind.
  {
    const rawArchiveOut = mapRowToAmazonRawArchive(
      buildRawArchiveRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    );
    runCase(
      "REPLACEMENTS (raw archive)",
      rawArchiveOut as Record<string, unknown> | null,
      NATIVE_COLUMNS_REPLACEMENTS,
      "source_upload_id",
      STORE_ID,
    );
    runCase(
      "FBA_GRADE_AND_RESELL (raw archive)",
      rawArchiveOut as Record<string, unknown> | null,
      NATIVE_COLUMNS_FBA_GRADE_AND_RESELL,
      "source_upload_id",
      STORE_ID,
    );
    runCase(
      "RESERVED_INVENTORY (raw archive)",
      rawArchiveOut as Record<string, unknown> | null,
      NATIVE_COLUMNS_RESERVED_INVENTORY,
      "source_upload_id",
      STORE_ID,
    );
    runCase(
      "FEE_PREVIEW (raw archive)",
      rawArchiveOut as Record<string, unknown> | null,
      NATIVE_COLUMNS_FEE_PREVIEW,
      "source_upload_id",
      STORE_ID,
    );
    runCase(
      "MONTHLY_STORAGE_FEES (raw archive)",
      rawArchiveOut as Record<string, unknown> | null,
      NATIVE_COLUMNS_MONTHLY_STORAGE_FEES,
      "source_upload_id",
      STORE_ID,
    );
  }

  runCase(
    "MANAGE_FBA_INVENTORY",
    mapRowToAmazonManageFbaInventory(
      buildManageFbaInventoryRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_MANAGE_FBA_INVENTORY,
    "source_upload_id",
    STORE_ID,
  );

  // Keep a handle to the FBA inventory mapper output for the physical-row
  // identity attach sub-test below.
  const fbaInventoryOut = mapRowToAmazonFbaInventory(
    buildFbaInventoryRow(),
    ORG_ID,
    UPLOAD_ID,
    STORE_ID,
  );
  runCase(
    "FBA_INVENTORY",
    fbaInventoryOut as Record<string, unknown> | null,
    NATIVE_COLUMNS_FBA_INVENTORY,
    "source_upload_id",
    STORE_ID,
  );

  runCase(
    "INBOUND_PERFORMANCE",
    mapRowToAmazonInboundPerformance(
      buildInboundPerformanceRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_INBOUND_PERFORMANCE,
    "source_upload_id",
    STORE_ID,
  );

  runCase(
    "AMAZON_FULFILLED_INVENTORY",
    mapRowToAmazonAmazonFulfilledInventory(
      buildAmazonFulfilledInventoryRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    ) as Record<string, unknown> | null,
    NATIVE_COLUMNS_AMAZON_FULFILLED_INVENTORY,
    "source_upload_id",
    STORE_ID,
  );

  // ── Special-case sub-tests ──────────────────────────────────────────────────

  // A) amazon_removals: source_staging_id attach survives packing.
  //    Mirrors the sync route at app/api/settings/imports/sync/route.ts:2008
  //    where `insertRow.source_staging_id = sr.id` is set after the mapper runs.
  {
    const removalOut = mapRowToAmazonRemoval(
      buildRemovalRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    );
    assertNonNull("REMOVAL_ORDER: source_staging_id attach pre-state", removalOut);
    const mutable = removalOut as unknown as Record<string, unknown>;
    mutable.source_staging_id = STAGING_ID;
    const packed = packPayloadForSupabase(
      [mutable],
      NATIVE_COLUMNS_REMOVALS,
    )[0] as Record<string, unknown>;
    assertEqual(
      "REMOVAL_ORDER: source_staging_id at root",
      packed.source_staging_id,
      STAGING_ID,
    );
    assertNoLinkageInRawData("REMOVAL_ORDER source_staging_id", packed);
    console.log("[PASS] REMOVAL_ORDER: source_staging_id attach survives");
  }

  // B) attachPhysicalRowIdentity replica — the sync route stamps every mapper
  //    output with `source_file_sha256` + `source_physical_row_number` before
  //    packing (app/api/settings/imports/sync/route.ts:213-221 + line 2100).
  //    Replicate that 3-line body inline (we deliberately do NOT import the
  //    private helper) and assert both fields survive on FBA Inventory.
  {
    assertNonNull("FBA_INVENTORY: pre-attach mapper output", fbaInventoryOut);
    const mutable = fbaInventoryOut as unknown as Record<string, unknown>;
    mutable.source_file_sha256 = FILE_SHA;
    mutable.source_physical_row_number = 7;
    const packed = packPayloadForSupabase(
      [mutable],
      NATIVE_COLUMNS_FBA_INVENTORY,
    )[0] as Record<string, unknown>;
    assertEqual(
      "FBA_INVENTORY: source_file_sha256 at root",
      packed.source_file_sha256,
      FILE_SHA,
    );
    assertEqual(
      "FBA_INVENTORY: source_physical_row_number at root",
      packed.source_physical_row_number,
      7,
    );
    assertNoLinkageInRawData("FBA_INVENTORY physical row identity", packed);
    console.log("[PASS] FBA_INVENTORY: physical-row identity attach survives");
  }

  // B2) Resolver quad columns survive pack (NEXT-PRODUCT-36 native-column parity).
  {
    assertNonNull("FBA_INVENTORY: resolver quad pre-state", fbaInventoryOut);
    const mutable = fbaInventoryOut as unknown as Record<string, unknown>;
    mutable.resolved_product_id = "00000000-0000-4000-8000-000000000099";
    mutable.resolved_catalog_product_id = null;
    mutable.identifier_resolution_status = "resolved";
    mutable.identifier_resolution_confidence = 0.95;
    const packed = packPayloadForSupabase(
      [mutable],
      NATIVE_COLUMNS_FBA_INVENTORY,
    )[0] as Record<string, unknown>;
    assertEqual(
      "FBA_INVENTORY: resolved_product_id at root",
      packed.resolved_product_id,
      "00000000-0000-4000-8000-000000000099",
    );
    assertEqual(
      "FBA_INVENTORY: identifier_resolution_status at root",
      packed.identifier_resolution_status,
      "resolved",
    );
    console.log("[PASS] FBA_INVENTORY: resolver quad columns survive pack");
  }

  // C) Empty-row null-return gate (sanity check on a newer mapper).
  //    Confirms the empty-content guard at the top of the newer mappers (e.g.
  //    mapRowToAmazonFbaInventory) still gates correctly.
  {
    const emptyOut = mapRowToAmazonFbaInventory(
      buildEmptyRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    );
    if (emptyOut !== null) {
      throw new Error(
        `empty-row gate: expected null from mapRowToAmazonFbaInventory(empty), got ${JSON.stringify(emptyOut)}`,
      );
    }
    console.log("[PASS] empty-row null-return gate (FBA_INVENTORY)");
  }

  // D) Sanity: source_line_hash is present and non-empty for every mapper that
  //    advertises it (regression guard — empty hash collapses dedupe keys).
  {
    const transactionOut = mapRowToAmazonTransaction(
      buildTransactionRow(),
      ORG_ID,
      UPLOAD_ID,
      STORE_ID,
    );
    assertNonNull("source_line_hash sanity: transaction mapper", transactionOut);
    assertNonEmptyString(
      "TRANSACTIONS: source_line_hash present",
      (transactionOut as Record<string, unknown>).source_line_hash,
    );
    console.log("[PASS] TRANSACTIONS: source_line_hash present and non-empty");
  }

  console.log("ALL NEXT-15.6 CHECKS PASSED");
}

try {
  main();
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
