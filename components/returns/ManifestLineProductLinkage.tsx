"use client";

import type { ExpectedItem } from "@/app/returns/returns-action-types";
import {
  RESOLVER_SOURCE_LABEL,
  RESOLVER_SOURCE_LABEL_COMPACT,
  formatLinkageConfidence,
  resolutionStatusBadgeClass,
  resolutionStatusLabel,
} from "@/lib/scanner-product-linkage-ui";

type Props = {
  line: ExpectedItem;
};

/** Compact resolver status for manifest / packing-slip lines (no product fetch). */
export function ManifestLineProductLinkage({ line }: Props) {
  const status = line.identifier_resolution_status ?? null;
  const confidence = formatLinkageConfidence(line.identifier_resolution_confidence);
  if (!status && !line.resolved_product_id) return null;

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1"
      title={`Resolver: ${RESOLVER_SOURCE_LABEL}`}
    >
      <span
        className={[
          "inline-flex rounded-md border px-1.5 py-0.5 text-[9px] font-semibold",
          resolutionStatusBadgeClass(status),
        ].join(" ")}
        title={RESOLVER_SOURCE_LABEL}
      >
        {resolutionStatusLabel(status)}
      </span>
      {confidence && (
        <span className="text-[9px] text-muted-foreground">{confidence}</span>
      )}
      <span className="text-[9px] text-muted-foreground">{RESOLVER_SOURCE_LABEL_COMPACT}</span>
    </div>
  );
}
