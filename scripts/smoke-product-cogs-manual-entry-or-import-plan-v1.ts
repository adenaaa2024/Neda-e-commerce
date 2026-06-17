/**
 * smoke-product-cogs-manual-entry-or-import-plan-v1
 *   npx tsx scripts/smoke-product-cogs-manual-entry-or-import-plan-v1.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FORMULA_CONTRACT,
  PLAN_OPTIONS,
  PRODUCT_COGS_MANUAL_ENTRY_OR_IMPORT_PLAN_V1_VERSION,
  REJECTED_COLUMNS_OR_SOURCES,
} from "../lib/products/contracts/product-cogs-manual-entry-or-import-plan-v1";

const plan = readFileSync(
  "lib/products/contracts/product-cogs-manual-entry-or-import-plan-v1.ts",
  "utf8",
);
const script = readFileSync("scripts/phase-product-cogs-manual-entry-or-import-plan-v1.ts", "utf8");

assert.equal(PRODUCT_COGS_MANUAL_ENTRY_OR_IMPORT_PLAN_V1_VERSION, "product-cogs-manual-entry-or-import-plan-v1");
assert.match(plan, /approved_by/);
assert.match(plan, /product_prices/);
assert.match(FORMULA_CONTRACT.recovery_value, /clean_quantity/);
assert.equal(PLAN_OPTIONS.C_pim_product_master_wiring.status, "not_recommended_as_cogs_spine");
assert.ok(REJECTED_COLUMNS_OR_SOURCES.sources.some((s) => s.includes("product_prices")));
assert.match(script, /default_transaction_read_only = ON/);
assert.doesNotMatch(script, /\.insert\(/);
assert.doesNotMatch(script, /apply_migration/);

console.log(JSON.stringify({ ok: true, smoke: "pass" }, null, 2));
