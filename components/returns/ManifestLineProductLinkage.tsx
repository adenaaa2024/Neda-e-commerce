"use client";

import type { ExpectedItem } from "@/app/returns/returns-action-types";
import { mapExpectedItemToProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import { ProductLinkageDisplayBlock } from "@/components/product-linkage/ProductLinkageDisplayBlock";

type Props = {
  line: ExpectedItem;
  lineKey?: string;
};

/** Compact resolver status for manifest / packing-slip lines (V178 contract). */
export function ManifestLineProductLinkage({ line, lineKey = "0" }: Props) {
  const linkage = mapExpectedItemToProductLinkageDisplayContract({
    source_table: "packages.manifest_data",
    source_row_id: `manifest:${lineKey}`,
    line: line as unknown as Record<string, unknown>,
  });
  if (!linkage.identifier_resolution_status && !linkage.resolved_product_id) return null;

  return <ProductLinkageDisplayBlock linkage={linkage} compact showPimLink={false} />;
}
