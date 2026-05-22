"use client";

import { useEffect, useState } from "react";

import {
  fetchProductLinkageDisplayContract,
} from "@/app/returns/product-linkage-display-actions";
import { ProductLinkageDisplayBlock } from "@/components/product-linkage/ProductLinkageDisplayBlock";
import { mapRowToProductLinkageDisplayContract, type ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import type { ProductLinkageFields } from "@/lib/scanner-product-linkage-ui";

type Props = {
  organizationId: string;
  fields: ProductLinkageFields & { id?: string | null };
  compact?: boolean;
  /** When true, fetch canonical product title/category when resolved. */
  showCanonical?: boolean;
};

export function ReturnItemProductLinkage({
  organizationId,
  fields,
  compact = false,
  showCanonical = true,
}: Props) {
  const fallback = mapRowToProductLinkageDisplayContract({
    source_table: "return_items",
    source_row_id: fields.id ?? "return_item",
    row: fields as unknown as Record<string, unknown>,
  });
  const [linkage, setLinkage] = useState<ProductLinkageDisplayContract>(fallback);

  useEffect(() => {
    const nextFallback = mapRowToProductLinkageDisplayContract({
      source_table: "return_items",
      source_row_id: fields.id ?? "return_item",
      row: fields as unknown as Record<string, unknown>,
    });
    setLinkage(nextFallback);
    if (!showCanonical || !fields.resolved_product_id) {
      return;
    }
    let cancelled = false;
    void fetchProductLinkageDisplayContract({
      organizationId,
      source_table: "return_items",
      source_row_id: fields.id ?? "return_item",
      row: fields as unknown as Record<string, unknown>,
    }).then((res) => {
      if (cancelled) return;
      setLinkage(res);
    });
    return () => {
      cancelled = true;
    };
  }, [
    organizationId,
    fields.id,
    fields.item_name,
    fields.sku,
    fields.asin,
    fields.fnsku,
    fields.product_identifier,
    fields.resolved_product_id,
    fields.resolved_catalog_product_id,
    fields.identifier_resolution_status,
    fields.identifier_resolution_confidence,
    showCanonical,
  ]);

  return (
    <ProductLinkageDisplayBlock
      linkage={linkage}
      organizationId={organizationId}
      compact={compact}
    />
  );
}
