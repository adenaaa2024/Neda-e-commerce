"use client";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { ProductLinkageDisplayBlock } from "@/components/product-linkage/ProductLinkageDisplayBlock";

export function ProductLinkagePanel({ row }: { row: ClaimCenterV1Row }) {
  const linked = row.product_linkage?.is_resolved;
  return (
    <section className="claim-center-card mb-4 rounded-xl p-3">
      <h3 className="text-sm font-semibold">Product linkage</h3>
      <p className="mt-1 text-xs opacity-70">
        {linked ? "Product identifiers resolve to catalog." : row.product_unresolved_reason ?? "Product not linked."}
      </p>
      {row.product_linkage ? (
        <div className="mt-3">
          <ProductLinkageDisplayBlock linkage={row.product_linkage} compact />
        </div>
      ) : (
        <p className="mt-2 text-xs">
          SKU {row.sku ?? "—"} · ASIN {row.asin ?? "—"} · FNSKU {row.fnsku ?? "—"}
        </p>
      )}
    </section>
  );
}
