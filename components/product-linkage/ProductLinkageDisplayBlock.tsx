"use client";

import Link from "next/link";
import { AlertTriangle, Link2 } from "lucide-react";

import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import {
  PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW,
  productLinkageConfidenceLabel,
  productLinkageDisplayHeadline,
  productLinkageUserStatusBadgeClass,
  productLinkageUserStatusLabel,
} from "@/lib/product-linkage-display-ui";
import {
  RESOLVER_SOURCE_LABEL,
  isAmbiguousLinkageStatus,
  isUnresolvedLinkageStatus,
  normalizeResolutionStatus,
} from "@/lib/scanner-product-linkage-ui";

type Props = {
  linkage: ProductLinkageDisplayContract;
  organizationId?: string;
  compact?: boolean;
  showPimLink?: boolean;
  className?: string;
};

export function ProductLinkageDisplayBlock({
  linkage,
  organizationId,
  compact = false,
  showPimLink = true,
  className = "",
}: Props) {
  const status = normalizeResolutionStatus(linkage.identifier_resolution_status);
  const headline = productLinkageDisplayHeadline(linkage);
  const statusLabel = productLinkageUserStatusLabel(linkage);
  const confidence = productLinkageConfidenceLabel(linkage);
  const ambiguous = isAmbiguousLinkageStatus(status);
  const unresolved = isUnresolvedLinkageStatus(status) || (!linkage.is_resolved && !ambiguous);

  const identifiers = [
    linkage.sku ? `SKU ${linkage.sku}` : null,
    linkage.asin ? `ASIN ${linkage.asin}` : null,
    linkage.fnsku ? `FNSKU ${linkage.fnsku}` : null,
    linkage.upc ? `UPC ${linkage.upc}` : null,
  ].filter(Boolean);

  return (
    <div className={compact ? `space-y-1 ${className}` : `space-y-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={[
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium leading-snug",
            compact ? "text-[9px]" : "text-[10px]",
            productLinkageUserStatusBadgeClass(linkage),
          ].join(" ")}
          title={`Resolver: ${RESOLVER_SOURCE_LABEL}`}
        >
          <Link2 className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
          {statusLabel}
        </span>
        {ambiguous ? (
          <span
            className={[
              "inline-flex items-center gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-semibold text-amber-900 dark:text-amber-200",
              compact ? "text-[9px]" : "text-[10px]",
            ].join(" ")}
          >
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW}
          </span>
        ) : null}
      </div>

      <div className={compact ? "text-[10px]" : "text-xs"}>
        <p className="font-medium text-foreground leading-snug">{headline}</p>
        {(unresolved || ambiguous) && identifiers.length > 0 ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">{identifiers.join(" · ")}</p>
        ) : null}
        {!compact && (
          <p className="text-[10px] text-muted-foreground">
            Source: {RESOLVER_SOURCE_LABEL}
            {confidence ? ` · confidence ${confidence}` : ""}
            {linkage.source_table ? ` · ${linkage.source_table}` : ""}
          </p>
        )}
      </div>

      {showPimLink && organizationId && linkage.resolved_product_id ? (
        <Link
          href={`/dashboard/products?organization_id=${encodeURIComponent(organizationId)}&highlight=${encodeURIComponent(linkage.resolved_product_id)}`}
          className="inline-flex text-[10px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Open product {linkage.resolved_product_id.slice(0, 8)}…
        </Link>
      ) : null}
    </div>
  );
}
