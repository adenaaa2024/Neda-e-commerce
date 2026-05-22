import {
  buildProductLinkageDisplayContract,
  type ProductLinkageDisplayContract,
} from "@/lib/scanner/product-linkage-display-contract";
import type { ReturnRecord } from "@/app/returns/returns-action-types";

/** Display-only linkage from a `return_items` list row (no extra catalog fetch). */
export function productLinkageFromReturnRecord(record: ReturnRecord): ProductLinkageDisplayContract {
  return buildProductLinkageDisplayContract(
    {
      resolved_product_id: record.resolved_product_id,
      identifier_resolution_status: record.identifier_resolution_status,
      identifier_resolution_confidence: record.identifier_resolution_confidence,
      item_name: record.item_name,
      fnsku: record.fnsku,
      sku: record.sku,
      asin: record.asin,
      product_identifier: record.product_identifier,
    },
    new Map(),
  );
}
