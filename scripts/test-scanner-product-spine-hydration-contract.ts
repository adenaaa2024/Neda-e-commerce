/**
 * Product spine app hydration contract tests (no DB).
 * Run: npx tsx scripts/test-scanner-product-spine-hydration-contract.ts
 */
import {
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  buildProductLinkageDisplayContract,
  productLinkageOperatorPrimaryDisplayLabel,
} from "../lib/scanner/product-linkage-display-contract";
import { buildInventoryViewProductLinkage } from "../lib/scanner/expected-packages-read-contract";
import type { VInventoryStatusRow } from "../lib/scanner/v-inventory-status";

function eq(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const PRODUCT_ID = "e3832e25-275f-4124-906b-f2d6b7931b86";
const PRODUCT_NAME = "Bobs Red Mill GF Baking Soda 4/16 Oz";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "1552698729";
const FNSKU = "X003S8RCBH";
const SKU = "B0112V2AQM-VEN";

function mockInvRow(partial: Partial<VInventoryStatusRow>): VInventoryStatusRow {
  return {
    expected_package_id: "",
    organization_id: "00000000-0000-0000-0000-000000000001",
    store_id: STORE_ID,
    tracking_number: TRACKING,
    id_slip_contents: null,
    sku: SKU,
    fnsku: FNSKU,
    asin: null,
    order_id: "returne-1",
    status: "expected",
    product_name: PRODUCT_NAME,
    product_display_name: PRODUCT_NAME,
    product_id: PRODUCT_ID,
    resolved_product_id: PRODUCT_ID,
    resolved_catalog_product_id: null,
    product_linkage_status: "resolved",
    identifier_resolution_status: "resolved",
    identifier_resolution_confidence: 1,
    carrier: "EXLA",
    total_expected: 216,
    total_scanned: 0,
    ...partial,
  };
}

// 1) Resolved row with view product_name, empty hydration map
const resolvedFromView = buildProductLinkageDisplayContract(
  {
    resolved_product_id: PRODUCT_ID,
    product_name: PRODUCT_NAME,
    identifier_resolution_status: "resolved",
  },
  new Map(),
);
eq(resolvedFromView.product_name === PRODUCT_NAME, "view product_name hydrates contract");
eq(
  productLinkageOperatorPrimaryDisplayLabel(resolvedFromView) === PRODUCT_NAME,
  "resolved row shows catalog name",
);

// 2) matched status + product id + product_name
const matchedRow = buildProductLinkageDisplayContract(
  {
    resolved_product_id: PRODUCT_ID,
    product_name: PRODUCT_NAME,
    identifier_resolution_status: "matched",
  },
  new Map(),
);
eq(matchedRow.identifier_resolution_status === "resolved", "matched normalizes to resolved for display");
eq(
  productLinkageOperatorPrimaryDisplayLabel(matchedRow) === PRODUCT_NAME,
  "matched + id + name shows linked name",
);

// 3) Unresolved row
const unresolved = buildProductLinkageDisplayContract(
  {
    fnsku: "X003SRBCH",
    sku: SKU,
    identifier_resolution_status: "unresolved",
  },
  new Map(),
);
eq(unresolved.resolved_product_id === null, "unresolved has no product id");
eq(
  productLinkageOperatorPrimaryDisplayLabel(unresolved) === PRODUCT_LINKAGE_UNMAPPED_LABEL,
  "unresolved shows unmapped label",
);

// 4) Typo FNSKU / OCR description must not create product link
const ocrOnly = buildProductLinkageDisplayContract(
  {
    fnsku: "X003SRBCH",
    description: "OCR title only",
    identifier_resolution_status: "unresolved",
  },
  new Map(),
);
eq(ocrOnly.resolved_product_id === null, "OCR/description does not infer product id");
eq(ocrOnly.product_name === null, "OCR/description does not set product_name without id");

// 5) Inventory view linkage — test tracking cohort without EP join or products fetch
const viewLinkage = buildInventoryViewProductLinkage(mockInvRow({}), undefined, new Map());
eq(viewLinkage.resolved_product_id === PRODUCT_ID, "view linkage keeps resolved id");
eq(viewLinkage.product_name === PRODUCT_NAME, "view linkage uses view product_name");
eq(
  productLinkageOperatorPrimaryDisplayLabel(viewLinkage) === PRODUCT_NAME,
  "tracking cohort displays product name",
);

// 6) product_display_name priority
const displayAlias = buildInventoryViewProductLinkage(
  mockInvRow({ product_name: null, product_display_name: PRODUCT_NAME }),
  undefined,
  new Map(),
);
eq(displayAlias.product_name === PRODUCT_NAME, "product_display_name hydrates when product_name null");

console.log("test-scanner-product-spine-hydration-contract: all checks passed");
