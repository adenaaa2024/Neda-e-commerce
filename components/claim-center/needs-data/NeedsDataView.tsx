"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import {
  computeAmountStatus,
  type ReadyToFileQueuePayload,
  type ReadyToFileRow,
} from "@/lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import {
  NEEDS_DATA_GROUPS,
  needsDataBlockerLabel,
  needsDataGroupForBlocker,
  type NeedsDataGroupId,
} from "@/lib/claims/center/claim-needs-data-contract";

function rowPrimaryBlocker(row: ReadyToFileRow): string {
  return row.hardened_gate?.primary_blocker ?? row.blockers[0] ?? "needs_manual_review";
}

function rowPrimaryGroup(row: ReadyToFileRow): NeedsDataGroupId {
  return needsDataGroupForBlocker(rowPrimaryBlocker(row));
}

function productLabel(row: ReadyToFileRow): string {
  return row.fnsku ?? row.sku ?? row.asin ?? "—";
}

function RowLine({ row }: { row: ReadyToFileRow }) {
  const amount = computeAmountStatus(row);
  const blockers = row.hardened_gate?.blockers ?? row.blockers;
  return (
    <li className="rounded-lg border px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold leading-tight">
            {(row.claim_family ?? "—").replace(/_/g, " ")}
            <span className="ml-2 font-mono text-[10px] opacity-55">{productLabel(row)}</span>
          </p>
          <p className="mt-0.5 opacity-60">
            Qty {row.clean_quantity ?? "—"}
            {row.removal_order_id ? ` · order ${row.removal_order_id}` : ""}
            {row.removal_shipment_id ? ` · shipment ${row.removal_shipment_id}` : ""}
          </p>
        </div>
        <span className={claimCenterBadgeTone(amount.amount_tone)}>{amount.amount_status_label}</span>
      </div>
      {blockers.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {blockers.map((b) => (
            <span key={b} className={claimCenterBadgeTone("danger")} title={b}>
              {needsDataBlockerLabel(b)}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function NeedsDataView() {
  const contract = getClaimCenterV2Page("needs_data");
  const { fetchJson, storeId } = useClaimCenter();
  const [payload, setPayload] = useState<ReadyToFileQueuePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!storeId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<ReadyToFileQueuePayload>("/api/claims/center/ready-to-file");
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load needs-data candidates.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const blockedRows = useMemo(() => payload?.blocked_rows ?? [], [payload]);

  const grouped = useMemo(() => {
    const map = new Map<NeedsDataGroupId, ReadyToFileRow[]>();
    for (const row of blockedRows) {
      const g = rowPrimaryGroup(row);
      const arr = map.get(g) ?? [];
      arr.push(row);
      map.set(g, arr);
    }
    return map;
  }, [blockedRows]);

  return (
    <ClaimCenterV2PageShell contract={contract}>
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading needs-data candidates…
        </div>
      ) : error ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </p>
      ) : blockedRows.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-12 text-center text-sm opacity-70">
          No blocked candidates in scope. Candidates appear here when a gate fails — they move to{" "}
          <Link href="/claim-center/ready-to-file" className="font-semibold underline">
            Ready to File
          </Link>{" "}
          automatically once every gate passes.
        </p>
      ) : (
        <div className="space-y-6">
          {/* Color-coded summary tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {NEEDS_DATA_GROUPS.map((g) => {
              const count = grouped.get(g.id)?.length ?? 0;
              return (
                <div
                  key={g.id}
                  className={`rounded-xl border p-3 ${
                    count > 0
                      ? "border-amber-500/35 bg-amber-500/10"
                      : "border-black/5 opacity-55 dark:border-white/10"
                  }`}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wide opacity-70">{g.label}</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums">{count}</p>
                </div>
              );
            })}
          </div>

          {/* Grouped blocked candidates */}
          {NEEDS_DATA_GROUPS.map((g) => {
            const rows = grouped.get(g.id) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={g.id} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-bold">
                    <span className={claimCenterBadgeTone("warning")}>{rows.length}</span>
                    {g.label}
                  </h2>
                </div>
                <p className="text-xs opacity-70">{g.description}</p>
                <p className="rounded-md bg-black/[0.03] px-2.5 py-1.5 text-[11px] leading-snug opacity-75 dark:bg-white/[0.04]">
                  <span className="font-semibold">To unblock:</span> {g.unblockHint}
                </p>
                <ul className="space-y-2">
                  {rows.map((row) => (
                    <RowLine key={row.claim_submission_id} row={row} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </ClaimCenterV2PageShell>
  );
}
