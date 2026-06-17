/**
 * smoke-product-cogs-audit-v1 — static checks
 *   npx tsx scripts/smoke-product-cogs-audit-v1.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lib = readFileSync("lib/claims/submission/product-cogs-audit-v1.ts", "utf8");
const script = readFileSync("scripts/phase-product-cogs-audit-v1.ts", "utf8");

assert.match(lib, /approved_for_recovery: false/);
assert.match(lib, /product_prices/);
assert.match(lib, /NEVER COGS/);
assert.match(lib, /product_cost_snapshots/);
assert.match(lib, /cogs_overrides/);
assert.match(script, /default_transaction_read_only = ON/);
assert.match(script, /runProductCogsAuditV1/);
assert.doesNotMatch(script, /\.insert\(/);
assert.doesNotMatch(script, /\.update\(/);

console.log(JSON.stringify({ ok: true, smoke: "pass" }, null, 2));
