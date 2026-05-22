"use client";

import React, { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Hash, Loader2 } from "lucide-react";
import { PimHelpNote } from "./PimHelpNote";

export type IdentifierGroupMode = "seller_sku" | "asin" | "fnsku" | "upc_code";

type GroupRow = { group_key: string; product_count: number };

const MODE_LABELS: Record<IdentifierGroupMode, string> = {
  seller_sku: "SKU (map)",
  asin: "ASIN",
  fnsku: "FNSKU",
  upc_code: "UPC",
};

export function PimIdentifierGroupsView({
  organizationId,
  storeId,
  onSearchThisKey,
}: {
  organizationId: string;
  storeId: string;
  onSearchThisKey: (key: string) => void;
}) {
  const [mode, setMode] = useState<IdentifierGroupMode>("asin");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const u = new URL("/api/dashboard/products/catalog/identifier-groups", window.location.origin);
      u.searchParams.set("organization_id", organizationId);
      u.searchParams.set("store_id", storeId);
      u.searchParams.set("mode", mode);
      u.searchParams.set("page", String(page));
      u.searchParams.set("page_size", String(pageSize));
      const res = await fetch(u.toString());
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        rows?: GroupRow[];
        total?: number;
      };
      if (!res.ok || !data.ok) {
        setRows([]);
        setTotal(0);
        setErr(data.error ?? "Failed to load groups.");
        return;
      }
      setRows((data.rows ?? []) as GroupRow[]);
      setTotal(Number(data.total ?? 0));
    } catch {
      setErr("Network error.");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [organizationId, storeId, mode, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [mode, storeId, organizationId, pageSize]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Group by</span>
        {(Object.keys(MODE_LABELS) as IdentifierGroupMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={[
              "rounded-lg border px-3 py-1.5 text-xs font-medium",
              mode === m ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted",
            ].join(" ")}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <div className="flex select-none items-center gap-1.5 text-xs text-muted-foreground">
        <span>Product counts are distinct products per code (linked identities).</span>
        <PimHelpNote label="Identifier groups">
          <div className="space-y-2">
            <div>Groups are built from your linked product identity rows. Placeholder-like codes are hidden server-side.</div>
            <div>If the AI module is enabled, mapping or validation may be assisted automatically.</div>
          </div>
        </PimHelpNote>
      </div>

      {err ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div>
      ) : null}

      <div className="max-h-[min(70vh,720px)] overflow-auto rounded-xl border border-border/60">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-20 bg-muted/95 backdrop-blur">
            <tr className="border-b border-border bg-muted/50">
              <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Identifier</th>
              <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Products</th>
              <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="px-4 py-16 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" aria-hidden />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No identifier groups for this mode and store.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={`${mode}:${r.group_key}`} className="border-b border-border/40 hover:bg-muted/15">
                  <td className="max-w-[280px] truncate px-3 py-2 font-mono text-xs" title={r.group_key}>
                    {r.group_key}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{r.product_count.toLocaleString()}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <button
                      type="button"
                      onClick={() => onSearchThisKey(r.group_key)}
                      className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
                    >
                      <Hash className="h-3 w-3" aria-hidden />
                      Search grid
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          Showing{" "}
          <span className="tabular-nums text-foreground">
            {total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)}
          </span>{" "}
          of {total.toLocaleString()} group{total === 1 ? "" : "s"} · Page {page} of {pages}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Per page</span>
            <select
              value={pageSize}
              disabled={loading}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => setPage(1)}
            className="h-9 rounded-lg border border-border px-2 text-xs hover:bg-muted disabled:opacity-40"
          >
            First
          </button>
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-2 text-xs hover:bg-muted disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </button>
          <button
            type="button"
            disabled={page >= pages || loading}
            onClick={() => setPage((p) => p + 1)}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-2 text-xs hover:bg-muted disabled:opacity-40"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={page >= pages || loading}
            onClick={() => setPage(pages)}
            className="h-9 rounded-lg border border-border px-2 text-xs hover:bg-muted disabled:opacity-40"
          >
            Last
          </button>
        </div>
      </div>
    </div>
  );
}
