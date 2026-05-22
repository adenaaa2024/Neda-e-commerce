"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ProductLinkageDisplayBlock } from "@/components/product-linkage/ProductLinkageDisplayBlock";
import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";

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

  return (
    <section className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-3 dark:border-emerald-900 dark:bg-emerald-950/30">
      <h3 className="text-sm font-semibold text-emerald-950 dark:text-emerald-100">Product linkage</h3>
      <ProductLinkageDisplayBlock linkage={linkage} organizationId={organizationId} />
    </section>
  );
}
