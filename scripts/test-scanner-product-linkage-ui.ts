/**
 * SCANNER-02E — unit checks for scanner product linkage display helpers.
 * Run: npx tsx scripts/test-scanner-product-linkage-ui.ts
 */
import assert from "node:assert/strict";

import {
  fallbackDisplayTitle,
  formatLinkageConfidence,
  isAmbiguousLinkageStatus,
  isUnresolvedLinkageStatus,
  pickProductRowDisplayName,
  rawIdentifierSummary,
  resolutionStatusBadgeClass,
  resolutionStatusLabel,
  resolveLinkageDisplayTitle,
  normalizeResolutionStatus,
} from "../lib/scanner-product-linkage-ui";
import { mapRowToProductLinkageDisplayContract } from "../lib/product-linkage-display-contract";

function eq<T>(actual: T, expected: T, label: string) {
  assert.deepEqual(actual, expected, label);
}

eq(resolutionStatusLabel("resolved"), "Linked", "resolved label");
eq(resolutionStatusLabel("ambiguous"), "Ambiguous", "ambiguous label");
eq(resolutionStatusLabel(null), "No map link", "null label");

eq(isUnresolvedLinkageStatus("unresolved"), true, "unresolved");
eq(isUnresolvedLinkageStatus(null), true, "null unresolved");
eq(isAmbiguousLinkageStatus("ambiguous"), true, "ambiguous");

eq(formatLinkageConfidence(0.92), "92%", "fraction confidence");
eq(formatLinkageConfidence(85), "85%", "percent confidence");

eq(
  fallbackDisplayTitle({ item_name: "  Widget ", sku: "SKU-1" }),
  "Widget",
  "title from item_name",
);
eq(
  fallbackDisplayTitle({ sku: "SKU-ONLY" }),
  "SKU-ONLY",
  "title fallback sku",
);

eq(pickProductRowDisplayName({ name: "Legacy" }), "Legacy", "name wins");
eq(
  pickProductRowDisplayName({ product_name: "PIM title" }),
  "PIM title",
  "product_name when name absent",
);
eq(
  pickProductRowDisplayName({ name: "  ", product_name: "Fallback" }),
  "Fallback",
  "product_name when name blank",
);

eq(
  resolveLinkageDisplayTitle("Canonical", { item_name: "OCR" }),
  "Canonical",
  "canonical over OCR",
);
eq(
  resolveLinkageDisplayTitle(null, { item_name: "OCR only" }),
  "OCR only",
  "OCR when no canonical",
);

eq(
  rawIdentifierSummary({ asin: "B001", fnsku: "X1" }),
  "ASIN B001 · FNSKU X1",
  "identifier summary",
);

assert(
  resolutionStatusBadgeClass("ambiguous").includes("amber"),
  "ambiguous badge uses amber",
);

eq(normalizeResolutionStatus("matched"), "resolved", "matched normalizes to resolved");

const matchedLinked = mapRowToProductLinkageDisplayContract({
  source_table: "return_items",
  source_row_id: "ri-1",
  row: {
    resolved_product_id: "e3832e25-275f-4124-906b-f2d6b7931b86",
    identifier_resolution_status: "matched",
    catalog_product_name: "Bob's Red Mill",
    item_name: "OCR title",
  },
  product: { product_name: "Bob's Red Mill" },
});
assert(matchedLinked.is_resolved, "matched + resolved_product_id is display-linked");
eq(matchedLinked.product_name, "Bob's Red Mill", "catalog name hydrates");

console.log("test-scanner-product-linkage-ui: all checks passed");
