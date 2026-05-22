"use client";

import Link from "next/link";
import {
  buildOperatorProductDetailHref,
  productLinkageHasDetailPage,
  type OperatorProductDetailFrom,
} from "@/lib/scanner/operator-product-detail-path";
import {
  productLinkageOperatorPrimaryDisplayLabel,
  type ProductLinkageDisplayContract,
} from "@/lib/scanner/product-linkage-display-contract";

type ProductLinkagePrimaryLinkProps = {
  linkage: ProductLinkageDisplayContract;
  className?: string;
  /** When true, resolved catalog lines open the product detail route. */
  linkWhenResolved?: boolean;
  /** Context for product detail back navigation. */
  detailFrom?: OperatorProductDetailFrom;
  detailFromId?: string;
  onClick?: (e: React.MouseEvent) => void;
};

export function ProductLinkagePrimaryLink({
  linkage,
  className = "",
  linkWhenResolved = true,
  detailFrom,
  detailFromId,
  onClick,
}: ProductLinkagePrimaryLinkProps) {
  const label = productLinkageOperatorPrimaryDisplayLabel(linkage);
  const href =
    linkWhenResolved && productLinkageHasDetailPage(linkage)
      ? buildOperatorProductDetailHref(linkage.resolved_product_id!, {
          from: detailFrom,
          fromId: detailFromId,
        })
      : null;

  if (href) {
    return (
      <Link
        href={href}
        className={
          className ||
          "font-semibold text-sky-600 underline decoration-sky-400/70 underline-offset-2 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
        }
        onClick={onClick}
      >
        {label}
      </Link>
    );
  }

  return <span className={className || undefined}>{label}</span>;
}
