/**
 * V178 — product linkage display UI copy + spine display contract tests.
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
eq(unresolved.is_resolved === false, "unresolved not display-linked");

const ambiguous = mapRowToProductLinkageDisplayContract({
  source_table: "return_items",
  source_row_id: "b",
  row: { identifier_resolution_status: "ambiguous", item_name: "OCR Name" },
});
eq(productLinkageUserStatusLabel(ambiguous) === PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW, "ambiguous label");
eq(productLinkageDisplayHeadline(ambiguous) === "OCR Name", "ambiguous fallback");

/** Regression: spine id without explicit status must not show No Link. */
const spineIdNoStatus = mapRowToProductLinkageDisplayContract({
  source_table: "expected_packages",
  source_row_id: "ep-1",
  row: {
    resolved_product_id: "7e5e05f7-c98a-41a7-85e8-62720ffdc8de",
    fnsku: "X004LKS4VD",
    product_name: "Realemon Lemon Juice, 128 Fluid Ounce, 4 Per Case",
  },
});
eq(spineIdNoStatus.is_resolved === true, "spine id without status is resolved");
eq(productLinkageUserStatusLabel(spineIdNoStatus) === "Linked", "spine id without status label");

/** Regression: matched + resolved_product_id + view name (X004LKS4VD pattern). */
const matchedView = mapRowToProductLinkageDisplayContract({
  source_table: "v_inventory_item_status",
  source_row_id: "inv-1",
  row: {
    resolved_product_id: "7e5e05f7-c98a-41a7-85e8-62720ffdc8de",
    identifier_resolution_status: "matched",
    product_name: "Realemon Lemon Juice, 128 Fluid Ounce, 4 Per Case",
    fnsku: "X004LKS4VD",
  },
});
eq(matchedView.is_resolved === true, "matched view row resolved");
eq(productLinkageUserStatusLabel(matchedView) === "Linked", "matched view label");

/** B0000B11UX — legacy product_id + product join, no operational resolved_product_id. */
const legacyProductId = mapRowToProductLinkageDisplayContract({
  source_table: "products.detail",
  source_row_id: "8beddd08-4133-48fb-abc1-279e61af8caf",
  row: {
    product_id: "8beddd08-4133-48fb-abc1-279e61af8caf",
    asin: "B0000B11UX",
    fnsku: "B0000B11UX",
  },
  product: {
    id: "8beddd08-4133-48fb-abc1-279e61af8caf",
    product_name: "Desert Essence Mouthwash Tea Tree Oil 36/8 oz",
  },
});
eq(legacyProductId.is_resolved === true, "legacy product_id + product join resolved");
eq(productLinkageUserStatusLabel(legacyProductId) === "Linked", "legacy product_id label");

/** X003VSWH37 — resolved EP row with explicit status. */
const reimbHeavy = mapRowToProductLinkageDisplayContract({
  source_table: "expected_packages",
  source_row_id: "ep-x003",
  row: {
    resolved_product_id: "4730d58a-237a-4960-9152-0f40af45640d",
    identifier_resolution_status: "resolved",
    fnsku: "X003VSWH37",
    product_name: "Torani Blackberry Syrup, 750 ml",
  },
});
eq(reimbHeavy.is_resolved === true, "X003VSWH37 resolved");
eq(productLinkageUserStatusLabel(reimbHeavy) === "Linked", "X003VSWH37 label");

/** True unlinked control — no spine id, no map path. */
const trueUnlinked = mapRowToProductLinkageDisplayContract({
  source_table: "return_items",
  source_row_id: "unlinked-1",
  row: {
    fnsku: "X000NOMAP99",
    identifier_resolution_status: "unresolved",
  },
});
eq(trueUnlinked.is_resolved === false, "true unlinked stays unresolved");
eq(productLinkageUserStatusLabel(trueUnlinked) === PRODUCT_LINKAGE_LABEL_NO_LINK, "true unlinked label");

console.log("test-product-linkage-display-ui: all checks passed");
