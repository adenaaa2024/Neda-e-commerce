"use client";

import { useEffect, useState } from "react";
import { Link2, AlertTriangle } from "lucide-react";

import {
  fetchCanonicalProductDisplay,
  type CanonicalProductDisplay,
} from "@/app/returns/product-linkage-actions";
import type { ProductLinkageFields } from "@/lib/scanner-product-linkage-ui";
import {
  RESOLVER_SOURCE_LABEL,
  RESOLVER_SOURCE_LABEL_COMPACT,
  formatLinkageConfidence,
  resolveLinkageDisplayTitle,
  isAmbiguousLinkageStatus,
  isMismatchLinkageStatus,
  isUnresolvedLinkageStatus,
  rawIdentifierSummary,
  resolutionStatusBadgeClass,
  resolutionStatusLabel,
} from "@/lib/scanner-product-linkage-ui";

type Props = {
  organizationId: string;
  fields: ProductLinkageFields;
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
  const status = fields.identifier_resolution_status ?? null;
  const confidence = formatLinkageConfidence(fields.identifier_resolution_confidence);
  const [canonical, setCanonical] = useState<CanonicalProductDisplay | null>(null);
  const [loadingCanonical, setLoadingCanonical] = useState(false);

  const resolved = status === "resolved" && !!fields.resolved_product_id;
  const showUnresolved = isUnresolvedLinkageStatus(status);
  const showAmbiguous = isAmbiguousLinkageStatus(status);
  const showMismatch = isMismatchLinkageStatus(status);

  useEffect(() => {
    if (!showCanonical || !resolved || !fields.resolved_product_id) {
      setCanonical(null);
      return;
    }
    let cancelled = false;
    setLoadingCanonical(true);
    void fetchCanonicalProductDisplay({
      organizationId,
      resolvedProductId: fields.resolved_product_id,
      resolvedCatalogProductId: fields.resolved_catalog_product_id,
      itemExpirationDate: fields.expiration_date,
      linkageFields: {
        item_name: fields.item_name,
        sku: fields.sku,
        asin: fields.asin,
        fnsku: fields.fnsku,
        product_identifier: fields.product_identifier,
      },
    }).then((res) => {
      if (cancelled) return;
      setLoadingCanonical(false);
      if (res.ok) setCanonical(res.display);
    });
    return () => {
      cancelled = true;
    };
  }, [
    organizationId,
    fields.resolved_product_id,
    fields.resolved_catalog_product_id,
    fields.expiration_date,
    resolved,
    showCanonical,
  ]);

  const displayTitle = resolveLinkageDisplayTitle(
    resolved ? canonical?.title : null,
    fields,
  );

  return (
    <div className={compact ? "mt-1 space-y-1" : "mt-2 space-y-2"}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={[
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium leading-snug",
            compact ? "text-[9px]" : "text-[10px]",
            resolutionStatusBadgeClass(status),
          ].join(" ")}
          title={`Resolver: ${RESOLVER_SOURCE_LABEL}`}
        >
          <Link2 className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
          {resolutionStatusLabel(status)}
        </span>
        {showAmbiguous && (
          <span
            className={[
              "inline-flex items-center gap-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-semibold text-amber-900 dark:text-amber-200",
              compact ? "text-[9px]" : "text-[10px]",
            ].join(" ")}
          >
            <AlertTriangle className="h-3 w-3" aria-hidden />
            Review link
          </span>
        )}
        {showUnresolved && (
          <span
            className={[
              "rounded-md border border-slate-400/30 bg-slate-500/10 px-1.5 py-0.5 font-medium text-muted-foreground",
              compact ? "text-[9px]" : "text-[10px]",
            ].join(" ")}
          >
            Raw / OCR only
          </span>
        )}
        {showMismatch && (
          <span
            className={[
              "rounded-md border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-semibold text-rose-800 dark:text-rose-300",
              compact ? "text-[9px]" : "text-[10px]",
            ].join(" ")}
          >
            Legacy mismatch
          </span>
        )}
      </div>

      {!compact && (
        <p className="text-[10px] text-muted-foreground">
          Source: {RESOLVER_SOURCE_LABEL}
          {confidence ? ` · confidence ${confidence}` : ""}
          {fields.resolved_product_id
            ? ` · product ${fields.resolved_product_id.slice(0, 8)}…`
            : ""}
        </p>
      )}

      {compact && (status != null && String(status).trim() !== "") && (
        <p
          className="text-[9px] text-muted-foreground leading-tight truncate max-w-[14rem]"
          title={`Resolver: ${RESOLVER_SOURCE_LABEL}${fields.resolved_product_id ? ` · product ${fields.resolved_product_id}` : ""}`}
        >
          {RESOLVER_SOURCE_LABEL_COMPACT}
          {confidence ? ` · ${confidence}` : ""}
        </p>
      )}

      <div className={compact ? "text-[10px]" : "text-xs"}>
        <p className="font-medium text-foreground leading-snug">{displayTitle}</p>
        {loadingCanonical && resolved && (
          <p className="text-[10px] text-muted-foreground">Loading catalog…</p>
        )}
        {canonical?.category && (
          <p className="text-[10px] text-muted-foreground">Category: {canonical.category}</p>
        )}
        {canonical?.expiry && (
          <p className="text-[10px] text-muted-foreground">
            Expiry on item: {canonical.expiry.slice(0, 10)}
          </p>
        )}
        {(showUnresolved || showAmbiguous || !resolved) && (
          <p className="mt-0.5 text-[10px] text-muted-foreground">{rawIdentifierSummary(fields)}</p>
        )}
      </div>
    </div>
  );
}
