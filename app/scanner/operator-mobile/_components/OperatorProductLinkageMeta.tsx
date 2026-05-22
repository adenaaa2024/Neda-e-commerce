"use client";

import Link from "next/link";
import { scannerProductResolutionBadges } from "@/lib/scanner/product-resolution-badges";
import {
  buildOperatorProductDetailHref,
  productLinkageHasDetailPage,
  type OperatorProductDetailFrom,
} from "@/lib/scanner/operator-product-detail-path";
import {
  formatProductLinkageConfidencePct,
  PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageIsAmbiguous,
  productLinkageNoCatalogProduct,
  productLinkageShowsUnmappedLabel,
  type ProductLinkageDisplayContract,
} from "@/lib/scanner/product-linkage-display-contract";

const UNMAPPED_STYLE = {
  borderColor: "rgba(245,158,11,0.9)",
  backgroundColor: "rgba(120,53,15,0.5)",
  color: "#fde68a",
} as const;

const NEEDS_REVIEW_STYLE = {
  borderColor: "rgba(251,191,36,0.9)",
  backgroundColor: "rgba(146,64,14,0.55)",
  color: "#fef3c7",
} as const;

function LinkageChip({
  label,
  title,
  style,
}: {
  label: string;
  title?: string;
  style: { borderColor: string; backgroundColor: string; color: string };
}) {
  return (
    <span
      className="rounded border px-1 py-0.5 text-[8px] font-bold uppercase leading-none tracking-wide"
      style={style}
      title={title}
    >
      {label}
    </span>
  );
}

/** Neda operator chips for catalog linkage on slip / item inspection rows. */
export function OperatorProductLinkageMeta({
  linkage,
  linkResolvedProductId = true,
  detailFrom,
  detailFromId,
}: {
  linkage: ProductLinkageDisplayContract;
  /** When false, omit short-id link (use with `ProductLinkagePrimaryLink` to avoid duplicate links). */
  linkResolvedProductId?: boolean;
  detailFrom?: OperatorProductDetailFrom;
  detailFromId?: string;
}) {
  const ambiguous = productLinkageIsAmbiguous(linkage);
  const showUnmapped = productLinkageShowsUnmappedLabel(linkage);
  const badges = scannerProductResolutionBadges({
    identifier_resolution_status: linkage.identifier_resolution_status,
  }).filter((b) => b.key !== "ambiguous" && b.key !== "unresolved");
  const conf = formatProductLinkageConfidencePct(linkage.identifier_resolution_confidence);
  const showFallbackSubtitle =
    Boolean(linkage.fallback_display_name.trim()) &&
    (productLinkageNoCatalogProduct(linkage) ||
      (Boolean(linkage.product_name?.trim()) &&
        linkage.product_name!.trim() !== linkage.fallback_display_name.trim()));
  const resolvedId = linkage.resolved_product_id?.trim() ?? "";
  const showResolvedId =
    resolvedId.length > 0 && linkage.identifier_resolution_status === "resolved";

  if (!ambiguous && !showUnmapped && !badges.length && !conf && !showFallbackSubtitle && !showResolvedId) {
    return null;
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {ambiguous ? (
        <LinkageChip
          label={PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL}
          title="Multiple catalog matches — needs operator review"
          style={NEEDS_REVIEW_STYLE}
        />
      ) : null}
      {showUnmapped ? (
        <LinkageChip
          label={PRODUCT_LINKAGE_UNMAPPED_LABEL}
          title="No catalog product linked for this line"
          style={UNMAPPED_STYLE}
        />
      ) : null}
      {badges.map((b) => (
        <LinkageChip
          key={b.key}
          label={b.label}
          style={{
            borderColor: b.borderColor,
            backgroundColor: b.backgroundColor,
            color: b.color,
          }}
        />
      ))}
      {showResolvedId ? (
        linkResolvedProductId && productLinkageHasDetailPage(linkage) ? (
          <Link
            href={
              buildOperatorProductDetailHref(resolvedId, {
                from: detailFrom,
                fromId: detailFromId,
              })!
            }
            className="font-mono text-[9px] font-semibold tabular-nums text-sky-400 underline decoration-sky-500/50 underline-offset-2 hover:text-sky-300"
            title={`Open product ${resolvedId}`}
          >
            {resolvedId.slice(0, 8)}…
          </Link>
        ) : (
          <span
            className="font-mono text-[9px] font-semibold tabular-nums text-slate-400"
            title={`Product id ${resolvedId}`}
          >
            {resolvedId.slice(0, 8)}…
          </span>
        )
      ) : null}
      {conf ? (
        <span className="text-[9px] font-semibold tabular-nums text-slate-400" title="Resolution confidence">
          {conf}
        </span>
      ) : null}
      {showFallbackSubtitle ? (
        <span className="min-w-0 truncate text-[9px] font-medium text-slate-500" title={linkage.fallback_display_name}>
          {linkage.fallback_display_name}
        </span>
      ) : null}
    </div>
  );
}
