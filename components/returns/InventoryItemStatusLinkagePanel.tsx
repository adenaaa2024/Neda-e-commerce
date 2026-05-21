"use client";

import { useCallback, useEffect, useState } from "react";
import { Boxes, Loader2, Search } from "lucide-react";

import { fetchInventoryItemStatusForNeda } from "@/app/returns/inventory-views-linkage-actions";
import { ProductLinkageDisplayBlock } from "@/components/product-linkage/ProductLinkageDisplayBlock";
import type { NedaInventoryItemStatusRow } from "@/lib/inventory-views-neda-read-contract";
import {
  inventoryPackageStatusChipClass,
  inventoryPackageStatusLabel,
} from "@/lib/inventory-package-status-ui";

const VARIANCE_LABEL: Record<string, string> = {
  matched: "Matched",
  under_scanned: "Under scanned",
  over_scanned: "Over scanned",
  unknown: "Unknown",
  no_scan_target: "No scan target",
  aggregate_only: "Aggregate only",
  shortage: "Shortage",
  overage: "Overage",
  unexpected: "Unexpected",
  unresolved: "Unresolved",
};

type Props = {
  organizationId: string;
  storeId?: string | null;
  trackingNumber?: string | null;
  slipCode?: string | null;
  showFilters?: boolean;
  compact?: boolean;
  /** When a parent renders `InventoryPackageStatusChip`, hide duplicate v_inventory_status rollup. */
  hidePackageRollup?: boolean;
  className?: string;
};

export function InventoryItemStatusLinkagePanel({
  organizationId,
  storeId,
  trackingNumber: trackingProp,
  slipCode: slipProp,
  showFilters = false,
  compact = false,
  hidePackageRollup = false,
  className = "",
}: Props) {
  const [filterTracking, setFilterTracking] = useState(trackingProp?.trim() ?? "");
  const [filterSlip, setFilterSlip] = useState(slipProp?.trim() ?? "");
  const [rows, setRows] = useState<NedaInventoryItemStatusRow[]>([]);
  const [packageStatus, setPackageStatus] = useState<string | null>(null);
  const [packageTotals, setPackageTotals] = useState<{ expected: number; scanned: number } | null>(
    null,
  );
  const [readiness, setReadiness] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const effectiveTracking = (showFilters ? filterTracking : trackingProp)?.trim() || null;
  const effectiveSlip = (showFilters ? filterSlip : slipProp)?.trim() || null;

  const load = useCallback(async () => {
    if (!organizationId?.trim()) return;
    if (showFilters && !effectiveTracking && !effectiveSlip) {
      setError("Enter a tracking number or slip code.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetchInventoryItemStatusForNeda({
        organizationId: organizationId.trim(),
        storeId: storeId?.trim() || null,
        trackingNumber: effectiveTracking,
        slipCode: effectiveSlip,
        limit: 200,
      });
      if (!res.ok) {
        setError(res.error);
        setRows([]);
        setPackageStatus(null);
        return;
      }
      setRows(res.data.item_status_rows);
      setReadiness(res.data.linkage_readiness);
      setNotes(res.data.notes);
      if (res.data.package_status) {
        setPackageStatus(res.data.package_status.status);
        setPackageTotals({
          expected: res.data.package_status.total_expected,
          scanned: res.data.package_status.total_scanned,
        });
      } else {
        setPackageStatus(null);
        setPackageTotals(null);
      }
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [organizationId, storeId, effectiveTracking, effectiveSlip, showFilters]);

  useEffect(() => {
    if (showFilters) return;
    setFilterTracking(trackingProp?.trim() ?? "");
    setFilterSlip(slipProp?.trim() ?? "");
    void load();
  }, [showFilters, trackingProp, slipProp, organizationId, storeId, load]);

  useEffect(() => {
    if (!showFilters) return;
    setFilterTracking(trackingProp?.trim() ?? "");
    setFilterSlip(slipProp?.trim() ?? "");
  }, [showFilters, trackingProp, slipProp]);

  return (
    <div className={`space-y-3 ${className}`}>
      {showFilters ? (
        <div className="flex flex-wrap items-end gap-2">
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
          <label className="flex min-w-[120px] flex-1 flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Slip code
            </span>
            <input
              className="h-9 rounded-lg border border-border bg-background px-2 text-xs font-mono"
              value={filterSlip}
              onChange={(e) => setFilterSlip(e.target.value)}
              placeholder="id_slip_contents"
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
            Search inventory
          </button>
        </div>
      ) : null}

      {loading && !loaded ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading inventory views…
        </p>
      ) : null}

      {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}

      {!hidePackageRollup && packageStatus ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold text-muted-foreground">Package (v_inventory_status):</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${inventoryPackageStatusChipClass(packageStatus)}`}
          >
            {inventoryPackageStatusLabel(packageStatus)}
            {packageTotals ? (
              <span className="font-normal normal-case opacity-90">
                {packageTotals.scanned}/{packageTotals.expected}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      {loaded && rows.length === 0 && !loading && !error ? (
        <p className="text-center text-[13px] text-muted-foreground">
          No v_inventory_item_status rows for this filter.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
              <Boxes className="h-3 w-3" />
              Item status
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
                    Variance
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((row) => (
                  <tr key={row.source_row_id}>
                    <td className="px-3 py-2.5 align-top">
                      <p className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                        {row.sku || row.fnsku || "—"}
                      </p>
                      {row.slip_code ? (
                        <p className="text-[10px] text-muted-foreground">Slip {row.slip_code}</p>
                      ) : null}
                      <div className="mt-1.5">
                        <ProductLinkageDisplayBlock
                          linkage={row.product_linkage}
                          organizationId={organizationId}
                          compact={compact}
                          showPimLink={!compact}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center font-bold">{row.expected_quantity}</td>
                    <td className="px-3 py-2.5 text-center font-bold">{row.scanned_quantity}</td>
                    <td className="px-3 py-2.5 text-[10px] font-semibold text-muted-foreground">
                      {VARIANCE_LABEL[row.product_comparison.status] ??
                        VARIANCE_LABEL[row.variance_status] ??
                        row.variance_status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {notes.length > 0 ? (
            <ul className="list-inside list-disc text-[10px] text-muted-foreground">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}