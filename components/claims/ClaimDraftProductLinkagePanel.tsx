"use client";

import Link from "next/link";
import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import {
  formatLinkageConfidence,
  resolutionStatusBadgeClass,
  resolutionStatusLabel,
} from "@/lib/scanner-product-linkage-ui";

type Props = {
  organizationId: string;
  draftId: string;
};

export function ClaimDraftProductLinkagePanel({ organizationId, draftId }: Props) {
  const [linkage, setLinkage] = useState<ProductLinkageDisplayContract | null>(null);
  const [sourceTable, setSourceTable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/claims/drafts/${encodeURIComponent(draftId)}/product-linkage?organization_id=${encodeURIComponent(organizationId)}`,
        { credentials: "include" },
      );
      const j = (await res.json()) as {
        product_linkage?: ProductLinkageDisplayContract | null;
        source_table?: string;
        error?: string;
      };
      if (!res.ok) {
        setLinkage(null);
        setError(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        return;
      }
      setLinkage(j.product_linkage ?? null);
      setSourceTable(typeof j.source_table === "string" ? j.source_table : null);
    } catch (e) {
      setLinkage(null);
      setError(e instanceof Error ? e.message : "Failed to load product linkage");
    } finally {
      setLoading(false);
    }
  }, [draftId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <section className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
        <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
        Loading product linkage…
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40">
        Product linkage: {error}
      </section>
    );
  }

  if (!linkage) {
    return (
      <section className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-muted-foreground dark:border-slate-700">
        No operational product linkage for {sourceTable ?? "this draft"}.
      </section>
    );
  }

  const title = linkage.product_name ?? linkage.fallback_display_name;
  const status = linkage.identifier_resolution_status;

  return (
    <section className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-3 dark:border-emerald-900 dark:bg-emerald-950/30">
      <h3 className="text-sm font-semibold text-emerald-950 dark:text-emerald-100">Product linkage</h3>
      <p className="text-[11px] font-medium text-emerald-900 dark:text-emerald-200">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] text-slate-700 dark:text-slate-300">
        {linkage.sku ? (
          <>
            <dt className="font-medium">SKU</dt>
            <dd className="font-mono">{linkage.sku}</dd>
          </>
        ) : null}
        {linkage.asin ? (
          <>
            <dt className="font-medium">ASIN</dt>
            <dd className="font-mono">{linkage.asin}</dd>
          </>
        ) : null}
        {linkage.fnsku ? (
          <>
            <dt className="font-medium">FNSKU</dt>
            <dd className="font-mono">{linkage.fnsku}</dd>
          </>
        ) : null}
        <dt className="font-medium">Resolver</dt>
        <dd>
          {status ? (
            <span className={`rounded px-1.5 py-0.5 font-medium ${resolutionStatusBadgeClass(status)}`}>
              {resolutionStatusLabel(status)}
              {linkage.identifier_resolution_confidence != null
                ? ` · ${formatLinkageConfidence(linkage.identifier_resolution_confidence)}`
                : ""}
            </span>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      {linkage.resolved_product_id ? (
        <Link
          href={`/dashboard/products?organization_id=${encodeURIComponent(organizationId)}&highlight=${encodeURIComponent(linkage.resolved_product_id)}`}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Open product {linkage.resolved_product_id.slice(0, 8)}…
          <ExternalLink className="h-3 w-3" />
        </Link>
      ) : null}
    </section>
  );
}
