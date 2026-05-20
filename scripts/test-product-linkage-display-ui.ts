/**
 * V178 — product linkage display UI copy tests.
 */
import {
  PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW,
  PRODUCT_LINKAGE_LABEL_NO_LINK,
  productLinkageDisplayHeadline,
  productLinkageUserStatusLabel,
} from "../lib/product-linkage-display-ui";
import { mapRowToProductLinkageDisplayContract } from "../lib/product-linkage-display-contract";

function eq(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const unresolved = mapRowToProductLinkageDisplayContract({
  source_table: "return_items",
  source_row_id: "a",
  row: { identifier_resolution_status: "unresolved", sku: "X" },
});
eq(productLinkageUserStatusLabel(unresolved) === PRODUCT_LINKAGE_LABEL_NO_LINK, "unresolved label");
eq(productLinkageDisplayHeadline(unresolved) === "X", "fallback sku");

const ambiguous = mapRowToProductLinkageDisplayContract({
  source_table: "return_items",
  source_row_id: "b",
  row: { identifier_resolution_status: "ambiguous", item_name: "OCR Name" },
});
eq(productLinkageUserStatusLabel(ambiguous) === PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW, "ambiguous label");
eq(productLinkageDisplayHeadline(ambiguous) === "OCR Name", "ambiguous fallback");

console.log("test-product-linkage-display-ui: all checks passed");
