"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CLAIM_DRAFT_LIFECYCLE_STATUSES,
  CLAIM_DRAFT_SOURCE_TABLES,
} from "../../../lib/claim-drafts-api";

export type ClaimDraftListItem = {
  id: string;
  organization_id: string | null;
  store_id: string | null;
  source_table: string | null;
  source_row_id: string | null;
  claim_family: string | null;
  claim_reason: string | null;
  evidence_status: string | null;
  lifecycle_status: string | null;
  confidence_score: number | null;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  product_id: string | null;
  resolved_product_id: string | null;
  blocker_reasons: unknown;
  recommended_action: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export function ClaimDraftsReviewClient({ organizationId }: { organizationId: string }) {
  const [lifecycle, setLifecycle] = useState<string>("");
  const [sourceTable, setSourceTable] = useState<string>("");
  const [items, setItems] = useState<ClaimDraftListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalMatching, setTotalMatching] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseParams = useMemo(() => {
    const p = new URLSearchParams({
      organization_id: organizationId,
      limit: "50",
      include_total: "true",
    });
    if (lifecycle) p.set("lifecycle_status", lifecycle);
    if (sourceTable) p.set("source_table", sourceTable);
    return p;
  }, [organizationId, lifecycle, sourceTable]);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNextCursor(null);
    const p = new URLSearchParams(baseParams);
    try {
      const res = await fetch(`/api/claims/drafts?${p.toString()}`, { credentials: "include" });
      const body = (await res.json()) as unknown as Record<string, unknown>;
      if (!res.ok) {
        setItems([]);
        setTotalMatching(null);
        setError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      setItems((Array.isArray(body.items) ? body.items : []) as ClaimDraftListItem[]);
      setNextCursor(typeof body.next_cursor === "string" ? body.next_cursor : null);
      setTotalMatching(typeof body.total_matching === "number" ? body.total_matching : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [baseParams]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    const p = new URLSearchParams(baseParams);
    p.set("cursor", nextCursor);
    try {
      const res = await fetch(`/api/claims/drafts?${p.toString()}`, { credentials: "include" });
      const body = (await res.json()) as unknown as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      const batch = (Array.isArray(body.items) ? body.items : []) as ClaimDraftListItem[];
      setItems((prev) => [...prev, ...batch]);
      setNextCursor(typeof body.next_cursor === "string" ? body.next_cursor : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoadingMore(false);
    }
  }, [baseParams, nextCursor]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 text-slate-900 dark:text-slate-100">
      <header className="space-y-1 border-b border-slate-200 pb-4 dark:border-slate-700">
        <h1 className="text-xl font-semibold">Claim candidate drafts (V2 staging)</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Read-only review. No promotion to legacy Claim Inbox. Enable with{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">ENABLE_CLAIM_DRAFTS_REVIEW=true</code>
          .
        </p>
        {totalMatching != null && (
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Rows matching filters: {totalMatching.toLocaleString()}
          </p>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-600 dark:text-slate-400">Lifecycle</span>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-600 dark:bg-slate-900"
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value)}
          >
            <option value="">All</option>
            {CLAIM_DRAFT_LIFECYCLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-600 dark:text-slate-400">Source table</span>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-600 dark:bg-slate-900"
            value={sourceTable}
            onChange={(e) => setSourceTable(e.target.value)}
          >
            <option value="">All</option>
            {CLAIM_DRAFT_SOURCE_TABLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
          onClick={() => void loadFirst()}
          disabled={loading}
        >
          Apply filters
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-900">
              <tr>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">Created</th>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">Lifecycle</th>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">Source</th>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">SKU</th>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">ASIN</th>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">Family / reason</th>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">Evidence</th>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">Recommended</th>
                <th className="border-b border-slate-200 px-2 py-2 dark:border-slate-700">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800">
                  <td className="whitespace-nowrap px-2 py-1.5 text-slate-600 dark:text-slate-400">
                    {row.created_at ? String(row.created_at).slice(0, 19) : "—"}
                  </td>
                  <td className="px-2 py-1.5">{row.lifecycle_status ?? "—"}</td>
                  <td className="max-w-[140px] truncate px-2 py-1.5" title={row.source_table ?? ""}>
                    {row.source_table ?? "—"}
                  </td>
                  <td className="max-w-[120px] truncate px-2 py-1.5" title={row.sku ?? ""}>
                    {row.sku ?? "—"}
                  </td>
                  <td className="px-2 py-1.5">{row.asin ?? "—"}</td>
                  <td className="max-w-[220px] truncate px-2 py-1.5" title={`${row.claim_family ?? ""} ${row.claim_reason ?? ""}`}>
                    {(row.claim_family ?? "") + " / " + (row.claim_reason ?? "").slice(0, 80)}
                  </td>
                  <td className="px-2 py-1.5">{row.evidence_status ?? "—"}</td>
                  <td className="max-w-[200px] truncate px-2 py-1.5" title={row.recommended_action ?? ""}>
                    {(row.recommended_action ?? "").slice(0, 60) || "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <Link
                      href={`/claim-engine/evidence?draft_id=${encodeURIComponent(row.id)}`}
                      className="font-medium text-emerald-700 hover:underline dark:text-emerald-300"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
