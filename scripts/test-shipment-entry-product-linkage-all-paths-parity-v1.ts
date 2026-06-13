/**
 * PHASE-SHIPMENT-ENTRY-PRODUCT-LINKAGE-ALL-PATHS-PARITY-FIX-V1 — unit tests (no DB).
 *
 *   npx tsx scripts/test-shipment-entry-product-linkage-all-paths-parity-v1.ts
 */
import {
  buildProductLinkageDisplayContract,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageOperatorPrimaryDisplayLabel,
} from "../lib/scanner/product-linkage-display-contract";
import {
  needsScannerLinkageResolve,
  productLinkageOperatorStatusLabel,
  PRODUCT_LINKAGE_LINKED_LABEL,
  PRODUCT_LINKAGE_NEEDS_PRODUCT_REVIEW_LABEL,
} from "../lib/scanner/normalize-scanner-product-linkage-display";

function eq(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const nameMap = new Map([["7e5e05f7-c98a-41a7-85e8-62720ffdc8de", "Realemon Lemon Juice"]]);

// expected path linked
const expectedLinked = buildProductLinkageDisplayContract(
  {
    resolved_product_id: "7e5e05f7-c98a-41a7-85e8-62720ffdc8de",
    identifier_resolution_status: "resolved",
    fnsku: "X004LKS4VD",
  },
  nameMap,
);
eq(productLinkageOperatorStatusLabel(expectedLinked) === PRODUCT_LINKAGE_LINKED_LABEL, "expected linked status");
eq(
  productLinkageOperatorPrimaryDisplayLabel(expectedLinked) === "Realemon Lemon Juice",
  "expected linked title",
);

// slip-only unresolved row shape (pre-enrich)
const slipUnresolved = buildProductLinkageDisplayContract(
  {
    fnsku: "ZZQDPD4GHB",
    upc: "071662213749",
    description: "Crayola Palm-Grip Crayons",
    identifier_resolution_status: "unresolved",
  },
  new Map(),
);
eq(
  needsScannerLinkageResolve({
    fnsku: "ZZQDPD4GHB",
    upc: "071662213749",
    description: "Crayola Palm-Grip Crayons",
    identifier_resolution_status: "unresolved",
  }),
  true,
  "slip-only needs resolve",
);
eq(
  productLinkageOperatorPrimaryDisplayLabel(slipUnresolved) === "Crayola Palm-Grip Crayons",
  "slip title uses description not No Link",
);
eq(
  productLinkageOperatorStatusLabel(slipUnresolved) === PRODUCT_LINKAGE_UNMAPPED_LABEL,
  "slip unresolved status",
);

// simulated post-enrich linked slip
const slipLinked = buildProductLinkageDisplayContract(
  {
    resolved_product_id: "7e5e05f7-c98a-41a7-85e8-62720ffdc8de",
    identifier_resolution_status: "resolved",
    fnsku: "X004LKS4VD",
    description: "Slip description",
  },
  nameMap,
);
eq(productLinkageOperatorStatusLabel(slipLinked) === PRODUCT_LINKAGE_LINKED_LABEL, "slip enriched linked");

// ambiguous
const ambiguous = buildProductLinkageDisplayContract(
  {
    fnsku: "X004AMBIG1",
    identifier_resolution_status: "ambiguous",
  },
  new Map(),
);
eq(
  productLinkageOperatorStatusLabel(ambiguous) === PRODUCT_LINKAGE_NEEDS_PRODUCT_REVIEW_LABEL,
  "ambiguous status",
);

// no map / no identifiers
const noIds = buildProductLinkageDisplayContract({}, new Map());
eq(needsScannerLinkageResolve({}) === false, "no identifiers skip resolve");
eq(productLinkageOperatorStatusLabel(noIds) === PRODUCT_LINKAGE_UNMAPPED_LABEL, "no map status");

// manual/off-expected row shape
eq(
  needsScannerLinkageResolve({
    sku: "B01C7G00TA-VEN",
    fnsku: "X004LKS4VD",
    identifier_resolution_status: "unresolved",
  }),
  true,
  "manual row needs resolve",
);

console.log("test-shipment-entry-product-linkage-all-paths-parity-v1: all checks passed");
