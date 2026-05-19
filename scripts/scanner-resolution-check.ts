/**
 * Lightweight checks for scanner product resolution helpers (run with `npx tsx scripts/scanner-resolution-check.ts`).
 */
import assert from "node:assert/strict";
import { scannerProductResolutionBadges } from "../lib/scanner/product-resolution-badges";
import { aggregateExpectedPackagesBySkuFnskuDisposition } from "../lib/scanner/operator-tracking-expectations";

const mm = scannerProductResolutionBadges({
  product_match_status: "mismatch",
  identifier_resolution_status: "resolved",
});
assert.ok(mm.some((b) => b.key === "mismatch"));

const amb = scannerProductResolutionBadges({ identifier_resolution_status: "ambiguous" });
assert.ok(amb.some((b) => b.key === "ambiguous"));

const manual = scannerProductResolutionBadges({
  identifier_resolution_status: "resolved",
  identifier_resolution_source: "manual_override",
});
assert.ok(manual.some((b) => b.key === "manual_override"));

const merged = aggregateExpectedPackagesBySkuFnskuDisposition([
  {
    sku: "S",
    fnsku: "F",
    disposition: "New",
    expected_scan_quantity: 1,
    order_id: "o",
    product_match_status: "match",
    identifier_resolution_status: "resolved",
    product_review_required: false,
  },
  {
    sku: "S",
    fnsku: "F",
    disposition: "New",
    expected_scan_quantity: 2,
    order_id: "o",
    product_match_status: "mismatch",
    identifier_resolution_status: "resolved",
    product_review_required: true,
  },
]);
assert.equal(merged.length, 1);
assert.equal(merged[0]?.product_match_status, "mismatch");
assert.equal(merged[0]?.product_review_required, true);

console.log("scanner-resolution-check: ok");
