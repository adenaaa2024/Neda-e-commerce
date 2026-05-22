/**
 * V169 — product linkage display contract mapper tests (no DB).
 */
import {
  mapExpectedItemToProductLinkageDisplayContract,
  mapRowToProductLinkageDisplayContract,
} from "../lib/product-linkage-display-contract";

function eq(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const resolvedReturn = mapRowToProductLinkageDisplayContract({
  source_table: "return_items",
  source_row_id: "f3a3ad84-4115-4cf2-8926-915434dc034a",
  row: {
    asin: "B00NGQVYG4",
    fnsku: "X004DMS1TT",
    item_name: "OCR Title",
    resolved_product_id: "246d6e3e-fcb5-406d-8087-e66cdcda2ce7",
    resolved_catalog_product_id: null,
    identifier_resolution_status: "resolved",
    identifier_resolution_confidence: 1,
  },
  product: { product_name: "DURACELL BATTERIES 1 PK" },
});

eq(resolvedReturn.is_resolved === true, "return_item resolved");
eq(resolvedReturn.resolved_product_id === "246d6e3e-fcb5-406d-8087-e66cdcda2ce7", "resolved id");
eq(resolvedReturn.product_name === "DURACELL BATTERIES 1 PK", "product_name from products row");
eq(
  resolvedReturn.fallback_display_name === "DURACELL BATTERIES 1 PK",
  "display uses canonical name when resolved",
);
eq(resolvedReturn.source_table === "return_items", "source_table");

const unresolvedSlip = mapRowToProductLinkageDisplayContract({
  source_table: "slip_contents",
  source_row_id: "ce558fa1-fab9-4b89-a88c-8c8905be6e8d",
  row: {
    fnsku: "ZZQCP25AW3",
    upc: "012345678905",
    identifier_resolution_status: "unresolved",
    resolved_product_id: null,
  },
});

eq(unresolvedSlip.is_resolved === false, "slip unresolved");
eq(unresolvedSlip.resolved_product_id === null, "no resolved id");
eq(unresolvedSlip.fallback_display_name === "ZZQCP25AW3", "fallback to fnsku");
eq(unresolvedSlip.upc === "012345678905", "upc mapped");

const ambiguous = mapRowToProductLinkageDisplayContract({
  source_table: "return_items",
  source_row_id: "a",
  row: {
    sku: "SKU-1",
    identifier_resolution_status: "ambiguous",
    identifier_resolution_confidence: 0.85,
    resolved_product_id: null,
  },
});
eq(ambiguous.is_resolved === false, "ambiguous not resolved");
eq(ambiguous.identifier_resolution_status === "ambiguous", "status preserved");

const manifestLine = mapExpectedItemToProductLinkageDisplayContract({
  source_table: "packages.manifest_data",
  source_row_id: "pkg:line:0",
  line: {
    sku: "ABC",
    asin: "B001",
    resolved_product_id: "11111111-1111-1111-1111-111111111111",
    identifier_resolution_status: "resolved",
  },
});
eq(manifestLine.source_table === "packages.manifest_data", "manifest source_table");
eq(manifestLine.is_resolved === true, "manifest line resolved when id present");

console.log("test-product-linkage-display-contract: all checks passed");
