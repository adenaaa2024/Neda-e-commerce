/**
 * V196 — verify duplicate map rows → same product_id resolve (not ambiguous).
 */
import { pickBestProductIdentifierMatch } from "../lib/product-identifier-match";
import type { ProductIdentifierMapRow } from "../lib/product-identifier-match";

const storeId = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const orgId = "00000000-0000-0000-0000-000000000001";
const productId = "fa03b233-3118-4bf7-b7f2-4f26ebc99221";
const fnsku = "X003JZMFRZ";

const duplicateRows: ProductIdentifierMapRow[] = [
  {
    id: "map-row-a",
    organization_id: orgId,
    product_id: productId,
    store_id: storeId,
    fnsku,
  } as ProductIdentifierMapRow,
  {
    id: "map-row-b",
    organization_id: orgId,
    product_id: productId,
    store_id: storeId,
    fnsku,
  } as ProductIdentifierMapRow,
];

const resolved = pickBestProductIdentifierMatch(duplicateRows, {
  organizationId: orgId,
  storeId,
  fnsku,
});

const distinctRows: ProductIdentifierMapRow[] = [
  {
    id: "map-row-c",
    organization_id: orgId,
    product_id: "11111111-1111-1111-1111-111111111111",
    store_id: storeId,
    fnsku,
  } as ProductIdentifierMapRow,
  {
    id: "map-row-d",
    organization_id: orgId,
    product_id: "22222222-2222-2222-2222-222222222222",
    store_id: storeId,
    fnsku,
  } as ProductIdentifierMapRow,
];

const ambiguous = pickBestProductIdentifierMatch(distinctRows, {
  organizationId: orgId,
  storeId,
  fnsku,
});

const ok =
  resolved.status === "resolved" &&
  resolved.row?.product_id === productId &&
  ambiguous.status === "ambiguous";

console.log(
  JSON.stringify(
    {
      guard: "v196-ambiguous-collapse-unit-smoke",
      status: ok ? "PASS" : "FAIL",
      resolved: { status: resolved.status, product_id: resolved.row?.product_id },
      ambiguous: { status: ambiguous.status },
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
