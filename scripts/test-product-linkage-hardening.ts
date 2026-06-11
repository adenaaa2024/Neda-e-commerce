/**
 * PHASE-PRODUCT-LINKAGE-HARDENING — unit checks (no DB).
 *   npx tsx scripts/test-product-linkage-hardening.ts
 */
import assert from "node:assert/strict";

import {
  expandBarcodeLookupValues,
  normalizeLinkageAsin,
  normalizeLinkageFnsku,
} from "../lib/product-linkage-identifier-normalize";
import {
  RESOLUTION_ORDER_OPERATIONAL,
  RESOLUTION_ORDER_SCANNER,
  computeProductLinkageConfidence,
  summarizeDuplicateRisks,
} from "../lib/product-linkage-resolution-policy";
import { pickBestProductIdentifierMatch, type ProductIdentifierMapRow } from "../lib/product-identifier-match";

assert.deepEqual(RESOLUTION_ORDER_SCANNER[0], "upc_ean_gtin");
assert.deepEqual(RESOLUTION_ORDER_OPERATIONAL[0], "fnsku");

assert.equal(normalizeLinkageAsin("b00koa1ymy"), "B00KOA1YMY");
assert.equal(normalizeLinkageFnsku("x001abc123"), "X001ABC123");

const upc12 = expandBarcodeLookupValues("012345678905");
assert.ok(upc12.includes("012345678905"));
assert.ok(upc12.includes("0012345678905"));

const ean13 = expandBarcodeLookupValues("0012345678905");
assert.ok(ean13.includes("0012345678905"));
assert.ok(ean13.includes("012345678905"));

const mapRow: ProductIdentifierMapRow = {
  id: "a",
  organization_id: "org",
  product_id: "p1",
  catalog_product_id: null,
  store_id: "s1",
  seller_sku: "SKU-1",
  asin: "B00TEST123",
  fnsku: "X000TEST01",
  msku: "SKU-1",
  title: null,
  disposition: null,
  external_listing_id: null,
};

const fnskuMatch = pickBestProductIdentifierMatch([mapRow], {
  organizationId: "org",
  storeId: "s1",
  fnsku: "x000test01",
});
assert.equal(fnskuMatch.status, "resolved");
assert.equal(fnskuMatch.tier, 1);

const conf = computeProductLinkageConfidence({
  status: "resolved",
  baseConfidence: 0.95,
  mapConfidenceScore: 0.92,
  matchedVia: "product_identifier_map.fnsku",
});
assert.ok(conf >= 0.95);

const dup = summarizeDuplicateRisks({ fnsku: 1, asin: 2, upc: 0, sku: 0 });
assert.equal(dup.total_conflict_groups, 3);
assert.equal(dup.safe_for_auto_map, false);

console.log(
  JSON.stringify(
    {
      ok: true,
      prompt: "PHASE-PRODUCT-LINKAGE-HARDENING",
      resolution_order_scanner: RESOLUTION_ORDER_SCANNER.join(" → "),
      resolution_order_operational: RESOLUTION_ORDER_OPERATIONAL.join(" → "),
    },
    null,
    2,
  ),
);
