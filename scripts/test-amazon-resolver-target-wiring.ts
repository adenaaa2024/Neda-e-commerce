/**
 * NEXT-PRODUCT-36 — Targeted wiring checks for amazon_fba_inventory resolver parity.
 * No database access.
 */
import {
  adaptResolverImportRow,
  type ResolveTargetTable,
} from "../lib/amazon-import-product-resolver";
import {
  INCREMENTAL_RESOLVER_TABLE_GATE,
  shouldUseIncrementalOrchestrator,
} from "../lib/amazon-resolver-incremental-gates";
import { NATIVE_COLUMNS_FBA_INVENTORY } from "../lib/import-sync-mappers";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const RESOLVER_NATIVE_KEYS = [
  "resolved_product_id",
  "resolved_catalog_product_id",
  "identifier_resolution_status",
  "identifier_resolution_confidence",
] as const;

function main(): void {
  const table: ResolveTargetTable = "amazon_fba_inventory";
  const gate = INCREMENTAL_RESOLVER_TABLE_GATE[table];
  assert(gate != null, "INCREMENTAL_RESOLVER_TABLE_GATE missing amazon_fba_inventory");
  assert(gate.envSuffix === "AMAZON_FBA_INVENTORY", "envSuffix must be AMAZON_FBA_INVENTORY");
  assert(gate.productCreationAllowed === false, "productCreationAllowed must be false");
  assert(gate.defaultOpenWhenMasterOn !== true, "FBA inventory gate must default closed");

  const prevMaster = process.env.RESOLVER_INCREMENTAL_PIPELINE;
  const prevTable = process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_FBA_INVENTORY;
  try {
    process.env.RESOLVER_INCREMENTAL_PIPELINE = "1";
    delete process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_FBA_INVENTORY;
    assert(
      shouldUseIncrementalOrchestrator(table, {}) === false,
      "incremental orchestrator must stay off without explicit table gate",
    );
    process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_FBA_INVENTORY = "1";
    assert(
      shouldUseIncrementalOrchestrator(table, {}) === true,
      "incremental orchestrator must enable when table gate is 1",
    );
  } finally {
    if (prevMaster === undefined) delete process.env.RESOLVER_INCREMENTAL_PIPELINE;
    else process.env.RESOLVER_INCREMENTAL_PIPELINE = prevMaster;
    if (prevTable === undefined) delete process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_FBA_INVENTORY;
    else process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_FBA_INVENTORY = prevTable;
  }

  for (const k of RESOLVER_NATIVE_KEYS) {
    assert(NATIVE_COLUMNS_FBA_INVENTORY.has(k), `NATIVE_COLUMNS_FBA_INVENTORY missing ${k}`);
  }

  const adapted = adaptResolverImportRow(table, {
    id: "00000000-0000-4000-8000-000000000001",
    fnsku: "X001",
    sku: "MSKU-1",
    asin: "B000TEST01",
    raw_data: { sku: "ignored-when-native-set" },
  });
  assert(adapted.fnsku === "X001", "adaptRow fnsku");
  assert(adapted.sku === "MSKU-1", "adaptRow sku");
  assert(adapted.asin === "B000TEST01", "adaptRow asin");
  assert(adapted.order_id === null, "adaptRow order_id null for FBA inventory");

  const fromRaw = adaptResolverImportRow(table, {
    id: "x",
    asin: "B0NATIVE",
    raw_data: { "merchant-sku": "RAW-SKU" },
  });
  assert(fromRaw.sku === "RAW-SKU", "adaptRow sku from raw_data fallback");
  assert(fromRaw.asin === "B0NATIVE", "adaptRow asin from native column");

  console.log("[PASS] amazon_fba_inventory resolver target wiring");
}

main();
