"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
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
  isMismatchLinkageStatus,
  isUnresolvedLinkageStatus,
  normalizeResolutionStatus,
} from "@/lib/scanner-product-linkage-ui";

type Props = {
  linkage: ProductLinkageDisplayContract;
  organizationId?: string;
  compact?: boolean;
  showPimLink?: boolean;
  className?: string;
  /** MENORIX palette for Returns desktop tables only. */
  menorixTable?: boolean;
};

const MENORIX_LINKAGE_BADGE = {
  resolved: "border-[rgba(138,104,31,0.20)] bg-[#EFE6D2] text-[#6C5320] dark:border-[rgba(214,183,110,0.25)] dark:bg-[#2A2418] dark:text-[#E8CF98]",
  unresolved: "border-[rgba(138,104,31,0.18)] bg-[#F2EEE5] text-[#4C5661] dark:border-[rgba(214,183,110,0.20)] dark:bg-[#20272F] dark:text-[#B8C1CB]",
  ambiguous: "border-[rgba(138,104,31,0.24)] bg-[#F5E9D2] text-[#6A4C16] dark:border-[rgba(214,183,110,0.28)] dark:bg-[#312613] dark:text-[#EFD49A]",
  mismatch: "border-[rgba(138,104,31,0.22)] bg-[#F3E5DE] text-[#6C3E34] dark:border-[rgba(214,183,110,0.24)] dark:bg-[#302025] dark:text-[#D7B2A8]",
  default: "border-[rgba(138,104,31,0.18)] bg-[#F2EEE5] text-[#737C86] dark:border-[rgba(214,183,110,0.20)] dark:bg-[#20272F] dark:text-[#7E8894]",
} as const;

export function ProductLinkageDisplayBlock({
  linkage,
  compact = false,
  showPimLink = true,
  className = "",
  menorixTable = false,
}: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const status = normalizeResolutionStatus(linkage.identifier_resolution_status);
  const headline = productLinkageDisplayHeadline(linkage);
  const statusLabel = productLinkageUserStatusLabel(linkage);
  const confidence = productLinkageConfidenceLabel(linkage);
  const ambiguous = isAmbiguousLinkageStatus(status);
  const unresolved = isUnresolvedLinkageStatus(status) || (!linkage.is_resolved && !ambiguous);
  const linkedProductId = linkage.resolved_product_id ?? linkage.product_id;
  const currentSearch = searchParams.toString();
  const currentPath = `${pathname}${currentSearch ? `?${currentSearch}` : ""}`;
  const productHref = linkedProductId
    ? `/pim/products/${encodeURIComponent(linkedProductId)}?back=${encodeURIComponent(currentPath)}`
    : null;

  const identifiers = [
    linkage.sku ? `SKU ${linkage.sku}` : null,
    linkage.asin ? `ASIN ${linkage.asin}` : null,
    linkage.fnsku ? `FNSKU ${linkage.fnsku}` : null,
    linkage.upc ? `UPC ${linkage.upc}` : null,
  ].filter(Boolean);

  function menorixBadgeClass(): string {
    const s = normalizeResolutionStatus(linkage.identifier_resolution_status);
    if (linkage.is_resolved && !isAmbiguousLinkageStatus(s) && !isUnresolvedLinkageStatus(s)) {
      return MENORIX_LINKAGE_BADGE.resolved;
    }
    if (isAmbiguousLinkageStatus(s)) return MENORIX_LINKAGE_BADGE.ambiguous;
    if (isMismatchLinkageStatus(s)) return MENORIX_LINKAGE_BADGE.mismatch;
    if (isUnresolvedLinkageStatus(s) || !linkage.is_resolved) return MENORIX_LINKAGE_BADGE.unresolved;
    return MENORIX_LINKAGE_BADGE.default;
  }

  const statusBadgeClass = menorixTable ? menorixBadgeClass() : productLinkageUserStatusBadgeClass(linkage);
  const metaTextClass = menorixTable ? "text-[#737C86] dark:text-[#7E8894]" : "text-muted-foreground";
  const headlineClass = menorixTable ? "text-[#171A1E] dark:text-[#F7F3EA]" : "text-foreground";
  const linkClass = menorixTable
    ? "font-medium leading-snug text-[#171A1E] underline decoration-[#B08A3C]/50 underline-offset-2 hover:text-[#8A681F] dark:text-[#F7F3EA] dark:decoration-[#D6B76E]/50 dark:hover:text-[#F1D58A]"
    : "font-medium leading-snug text-foreground underline decoration-sky-400/60 underline-offset-2 hover:text-sky-700 dark:hover:text-sky-300";
  const reviewBadgeClass = menorixTable
    ? "inline-flex items-center gap-0.5 rounded-md border border-[rgba(138,104,31,0.24)] bg-[#F5E9D2] px-1.5 py-0.5 font-semibold text-[#6A4C16] dark:border-[rgba(214,183,110,0.28)] dark:bg-[#312613] dark:text-[#EFD49A]"
    : "inline-flex items-center gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-semibold text-amber-900 dark:text-amber-200";

  return (
    <div className={compact ? `space-y-1 ${className}` : `space-y-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={[
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium leading-snug",
            compact ? "text-[9px]" : "text-[10px]",
            statusBadgeClass,
          ].join(" ")}
          title={`Resolver: ${RESOLVER_SOURCE_LABEL}`}
        >
          <Link2 className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
          {statusLabel}
        </span>
        {ambiguous ? (
          <span
            className={[
              reviewBadgeClass,
              compact ? "text-[9px]" : "text-[10px]",
            ].join(" ")}
          >
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {PRODUCT_LINKAGE_LABEL_NEEDS_REVIEW}
          </span>
        ) : null}
      </div>

      <div className={compact ? "text-[10px]" : "text-xs"}>
        {showPimLink && productHref ? (
          <Link
            href={productHref}
            onClick={(e) => e.stopPropagation()}
            className={linkClass}
          >
            {headline}
          </Link>
        ) : (
          <p className={`font-medium leading-snug ${headlineClass}`}>{headline}</p>
        )}
        {(unresolved || ambiguous) && identifiers.length > 0 ? (
          <p className={`mt-0.5 text-[10px] ${metaTextClass}`}>{identifiers.join(" · ")}</p>
        ) : null}
        {!compact && (
          <p className={`text-[10px] ${metaTextClass}`}>
            Source: {RESOLVER_SOURCE_LABEL}
            {confidence ? ` · confidence ${confidence}` : ""}
            {linkage.source_table ? ` · ${linkage.source_table}` : ""}
          </p>
        )}
      </div>

      {showPimLink && productHref && linkedProductId && !compact ? (
        <p className={`text-[10px] ${metaTextClass}`}>Product {linkedProductId.slice(0, 8)}…</p>
      ) : null}
    </div>
  );
}
