"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { fetchInventoryItemStatusForNeda } from "@/app/returns/inventory-views-linkage-actions";
import {
  inventoryPackageStatusChipClass,
  inventoryPackageStatusLabel,
} from "@/lib/inventory-package-status-ui";

type Props = {
  organizationId: string;
  storeId?: string | null;
  trackingNumber?: string | null;
  slipCode?: string | null;
  className?: string;
};

/**
 * Package-level status from v_inventory_status only (no product linkage).
 * Use when a compact chip is needed without the full item-status panel (e.g. future list rows).
 * Package drawer uses `InventoryItemStatusLinkagePanel` alone to avoid duplicate fetches/UI.
 */
export function InventoryPackageStatusChip({
  organizationId,
  storeId,
  trackingNumber,
  slipCode,
  className = "",
}: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [totals, setTotals] = useState<{ expected: number; scanned: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tn = trackingNumber?.trim();
    if (!organizationId?.trim() || !tn) {
      setStatus(null);
      setTotals(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void fetchInventoryItemStatusForNeda({
      organizationId,
      storeId,
      trackingNumber: tn,
      slipCode: slipCode?.trim() || null,
      packageStatusOnly: true,
      limit: 1,
    }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data.package_status) {
        setStatus(res.data.package_status.status);
        setTotals({
          expected: res.data.package_status.total_expected,
          scanned: res.data.package_status.total_scanned,
        });
      } else {
        setStatus(null);
        setTotals(null);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [organizationId, storeId, trackingNumber, slipCode]);

  if (!trackingNumber?.trim()) return null;

  if (loading) {
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] text-muted-foreground ${className}`}>
        <Loader2 className="h-3 w-3 animate-spin" />
        Inventory status…
      </span>
    );
  }

  if (!status) return null;

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${inventoryPackageStatusChipClass(status)} ${className}`}
      title={
        totals
          ? `Expected ${totals.expected} · Scanned ${totals.scanned} (v_inventory_status)`
          : "v_inventory_status"
      }
    >
      {inventoryPackageStatusLabel(status)}
      {totals ? (
        <span className="font-normal normal-case opacity-90">
          {totals.scanned}/{totals.expected}
        </span>
      ) : null}
    </span>
  );
}
