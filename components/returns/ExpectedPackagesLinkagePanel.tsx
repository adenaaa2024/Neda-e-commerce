"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Package2, Search } from "lucide-react";

import { fetchExpectedPackagesNedaRead } from "@/app/returns/expected-packages-linkage-actions";
import type { ReturnRecord } from "@/app/returns/returns-action-types";
import { ProductLinkageDisplayBlock } from "@/components/product-linkage/ProductLinkageDisplayBlock";
import type { NedaExpectedPackageReadRow } from "@/lib/expected-packages-neda-read-contract";
import {
  buildProductComparisonKeyBundle,
  productComparisonBundlesMatch,
} from "@/lib/inventory-product-comparison";

const VARIANCE_LABEL: Record<string, string> = {
  matched: "Matched",
  under_scanned: "Under scanned",
  over_scanned: "Over scanned",
  unknown: "Unknown",
  no_scan_target: "No scan target",
  shortage: "Shortage",
  overage: "Overage",
  unexpected: "Unexpected",
  unresolved: "Unresolved",
};

type Props = {
  organizationId: string;
  storeId?: string | null;
  orderId?: string | null;
  trackingNumber?: string | null;
  scannedItems?: ReturnRecord[];
  showFilters?: boolean;
  compact?: boolean;
  className?: string;
  onLoaded?: (rowCount: number) => void;
};

function itemMatchesExpectedPackage(it: ReturnRecord, row: NedaExpectedPackageReadRow): boolean {
  return productComparisonBundlesMatch(
    buildProductComparisonKeyBundle({
      resolved_product_id: row.product_linkage.resolved_product_id,
      product_id: row.product_linkage.product_id,
      sku: row.sku,
      fnsku: row.fnsku,
      asin: row.asin,
    }),
    buildProductComparisonKeyBundle({
      resolved_product_id: it.resolved_product_id,
      product_id: it.product_id,
      sku: it.sku,
      fnsku: it.fnsku,
      asin: it.asin,
      product_identifier: it.product_identifier,
    }),
  );
}

export function ExpectedPackagesLinkagePanel({
  organizationId,
  storeId,
  orderId: orderIdProp,
  trackingNumber: trackingProp,
  scannedItems,
  showFilters = false,
  compact = false,
  className = "",
  onLoaded,
}: Props) {
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const [filterOrderId, setFilterOrderId] = useState(orderIdProp?.trim() ?? "");
  const [filterTracking, setFilterTracking] = useState(trackingProp?.trim() ?? "");
  const [rows, setRows] = useState<NedaExpectedPackageReadRow[]>([]);
  const [readiness, setReadiness] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const effectiveOrderId = (showFilters ? filterOrderId : orderIdProp)?.trim() || null;
  const effectiveTracking = (showFilters ? filterTracking : trackingProp)?.trim() || null;

  const load = useCallback(async () => {
    if (!organizationId?.trim()) return;
    if (showFilters && !effectiveOrderId && !effectiveTracking) {
      setError("Enter an order ID or tracking number.");
      return;
    }
    if (!showFilters && !effectiveOrderId && !effectiveTracking) {
      setRows([]);
      setLoaded(true);
      onLoadedRef.current?.(0);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetchExpectedPackagesNedaRead({
        organizationId: organizationId.trim(),
        storeId: storeId?.trim() || null,
        orderId: effectiveOrderId,
        trackingNumber: effectiveTracking,
        limit: 200,
      });
      if (!res.ok) {
        setError(res.error);
        setRows([]);
        onLoadedRef.current?.(0);
        return;
      }
      setRows(res.data.rows);
      setReadiness(res.data.linkage_readiness);
      setNotes(res.data.notes);
      setLoaded(true);
      onLoadedRef.current?.(res.data.rows.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
      setRows([]);
      onLoadedRef.current?.(0);
    } finally {
      setLoading(false);
    }
  }, [organizationId, storeId, effectiveOrderId, effectiveTracking, showFilters]);

  useEffect(() => {
    if (showFilters) return;
    setFilterOrderId(orderIdProp?.trim() ?? "");
    setFilterTracking(trackingProp?.trim() ?? "");
    void load();
  }, [showFilters, orderIdProp, trackingProp, organizationId, storeId, load]);

  useEffect(() => {
    if (!showFilters) return;
    setFilterOrderId(orderIdProp?.trim() ?? "");
    setFilterTracking(trackingProp?.trim() ?? "");
  }, [showFilters, orderIdProp, trackingProp]);

  const scanned = useMemo(() => scannedItems ?? [], [scannedItems]);

  const tableRows = useMemo(
    () =>
      rows.map((row) => {
        const matched = scanned.filter((it) => itemMatchesExpectedPackage(it, row));
        const need = row.expected_quantity;
        const isMatch = matched.length >= need && need > 0;
        return { row, matched, need, isMatch };
      }),
    [rows, scanned],
  );

  return (
    <div className={`space-y-3 ${className}`}>
      {showFilters ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[140px] flex-1 flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Order ID
            </span>
            <input
              className="h-9 rounded-lg border border-border bg-background px-2 text-xs font-mono"
              value={filterOrderId}
              onChange={(e) => setFilterOrderId(e.target.value)}
              placeholder="Amazon order ID"
              autoComplete="off"
            />
          </label>
          <label className="flex min-w-[140px] flex-1 flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Tracking
            </span>
            <input
              className="h-9 rounded-lg border border-border bg-background px-2 text-xs font-mono"
              value={filterTracking}
              onChange={(e) => setFilterTracking(e.target.value)}
              placeholder="Carrier tracking"
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Search expected
          </button>
        </div>
      ) : null}

      {loading && !loaded ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading expected boxes…
        </p>
      ) : null}

      {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}

      {loaded && rows.length === 0 && !loading && !error ? (
        <p className="text-center text-[13px] text-muted-foreground">
          No expected box rows for this order / tracking filter.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
              <Package2 className="h-3 w-3" />
              Expected boxes
            </span>
            {readiness ? (
              <span className="text-[10px] font-semibold text-muted-foreground">Linkage {readiness}</span>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-2xl border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900">
                  <th className="px-3 py-2 text-left font-bold uppercase tracking-wide text-slate-400">
                    Product / identifiers
                  </th>
                  <th className="px-3 py-2 text-center font-bold uppercase tracking-wide text-slate-400">
                    Expected
                  </th>
                  <th className="px-3 py-2 text-center font-bold uppercase tracking-wide text-slate-400">
                    Scanned
                  </th>
                  <th className="px-3 py-2 text-left font-bold uppercase tracking-wide text-slate-400">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {tableRows.map(({ row, matched, need, isMatch }) => (
                  <tr
                    key={row.expected_package_id}
                    className={
                      isMatch
                        ? "bg-emerald-50/70 dark:bg-emerald-950/20"
                        : "bg-rose-50/50 dark:bg-rose-950/15"
                    }
                  >
                    <td className="px-3 py-2.5 align-top">
                      <p className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                        {row.sku || row.fnsku || "—"}
                      </p>
                      <div className="mt-1.5">
                        <ProductLinkageDisplayBlock
                          linkage={row.product_linkage}
                          organizationId={organizationId}
                          compact={compact}
                          showPimLink={!compact}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center font-bold">{need}</td>
                    <td className="px-3 py-2.5 text-center font-bold">
                      {scanned.length > 0 ? (
                        matched.length > 0 ? (
                          <span className="text-emerald-600">{matched.length}</span>
                        ) : (
                          <span className="text-rose-500">0</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">{row.scanned_quantity}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {scanned.length > 0 ? (
                        isMatch ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                            <CheckCircle2 className="h-3 w-3" />
                            Match
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                            Missing
                          </span>
                        )
                      ) : (
                        <span className="text-[10px] font-semibold text-muted-foreground">
                          {VARIANCE_LABEL[row.product_comparison.status] ??
                            VARIANCE_LABEL[row.variance_status] ??
                            row.variance_status}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {notes.length > 0 ? (
            <ul className="list-inside list-disc text-[10px] text-muted-foreground">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
