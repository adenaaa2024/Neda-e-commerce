"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, X } from "lucide-react";

import type {
  SettlementFrrReconciliationPayload,
  SettlementFrrLineSample,
} from "@/lib/amazon/settlement-frr-reconciliation-types";

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) throw new Error(`Empty ${res.status} response`);
  return JSON.parse(text) as T;
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "ok" | "warn" | "bad" | "neutral";
}) {
  const toneClass =
    tone === "ok"
      ? "border-emerald-500/40 bg-emerald-500/10"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10"
        : tone === "bad"
          ? "border-destructive/40 bg-destructive/10"
          : "border-border bg-muted/30";
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function SampleTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: SettlementFrrLineSample[];
  empty: string;
}) {
  if (!rows.length) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-foreground">{title}</h4>
      <div className="max-h-48 overflow-auto rounded-lg border border-border">
        <table className="w-full text-left text-[10px]">
          <thead className="sticky top-0 bg-muted/80 text-muted-foreground">
            <tr>
              <th className="px-2 py-1">Settlement id</th>
              <th className="px-2 py-1">Order</th>
              <th className="px-2 py-1">SKU</th>
              <th className="px-2 py-1">TRID key</th>
              <th className="px-2 py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.settlement_row_id}-${row.match_status}-${row.frr_id ?? "x"}`}
                className="border-t border-border"
              >
                <td className="px-2 py-1 font-mono">{row.settlement_id ?? "—"}</td>
                <td className="px-2 py-1">{row.order_id ?? "—"}</td>
                <td className="px-2 py-1">{row.sku ?? "—"}</td>
                <td className="max-w-[140px] truncate px-2 py-1 font-mono" title={row.trid_key ?? undefined}>
                  {row.trid_key ?? "—"}
                </td>
                <td className="px-2 py-1">{row.match_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SettlementFrrReconciliationDrawer({
  open,
  onClose,
  organizationId,
  uploadId,
  fileName,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  uploadId: string;
  fileName: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SettlementFrrReconciliationPayload | null>(null);
  const [tab, setTab] = useState<"matched" | "unmatched" | "conflicts">("matched");

  const load = useCallback(async () => {
    if (!organizationId || !uploadId) return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        organization_id: organizationId,
        sample_limit: "50",
      });
      const res = await fetch(
        `/api/settings/imports/uploads/${encodeURIComponent(uploadId)}/settlement-frr-reconciliation?${q}`,
        { cache: "no-store" },
      );
      const json = await readJson<SettlementFrrReconciliationPayload | { ok: false; error: string }>(res);
      if (!res.ok || json.ok === false) {
        throw new Error("error" in json ? json.error : `HTTP ${res.status}`);
      }
      setData(json);
      setTab(json.counts.unmatched_settlement_rows > 0 ? "unmatched" : "matched");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [organizationId, uploadId]);

  useEffect(() => {
    if (open) void load();
    else {
      setData(null);
      setError(null);
    }
  }, [open, load]);

  if (!open) return null;

  const c = data?.counts;
  const healthLabel =
    data?.health === "fully_reconciled"
      ? "Fully reconciled"
      : data?.health === "no_domain_rows"
        ? "No domain rows"
        : "Gaps detected";

  const copyId = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settlement-frr-recon-title"
    >
      <div className="flex h-full w-full max-w-lg flex-col border-l border-border bg-background shadow-xl">
        <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id="settlement-frr-recon-title" className="text-sm font-semibold text-foreground">
              Settlement ↔ FRR reconciliation
            </h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={fileName}>
              {fileName}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">{uploadId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading reconciliation…
            </p>
          )}
          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {data && c && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={[
                    "rounded-md px-2 py-0.5 text-xs font-medium",
                    data.health === "fully_reconciled"
                      ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                      : "bg-amber-500/15 text-amber-900 dark:text-amber-200",
                  ].join(" ")}
                >
                  {healthLabel}
                </span>
                <span className="text-xs text-muted-foreground">Read-only — no FRR writes</span>
              </div>

              {data.source_run && (
                <div className="space-y-1 rounded-lg border border-border bg-muted/20 p-3 text-xs">
                  <p>
                    <span className="text-muted-foreground">Source run:</span>{" "}
                    <span className="font-mono">{data.source_run.source_run_id ?? "—"}</span>
                    {data.source_run.source_run_id && (
                      <button
                        type="button"
                        className="ml-1 inline text-muted-foreground hover:text-foreground"
                        onClick={() => void copyId(data.source_run!.source_run_id!)}
                        aria-label="Copy source run id"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Amazon report id:</span>{" "}
                    <span className="font-mono">{data.source_run.report_id ?? "—"}</span>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Run state:</span> {data.source_run.state ?? "—"}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <MetricCard label="Settlement rows" value={c.settlement_rows} tone="neutral" />
                <MetricCard
                  label="FRR rows linked"
                  value={c.frr_linked}
                  tone={c.frr_linked >= c.settlement_rows ? "ok" : "warn"}
                />
                <MetricCard
                  label="Unmatched"
                  value={c.unmatched_settlement_rows}
                  tone={c.unmatched_settlement_rows === 0 ? "ok" : "bad"}
                />
                <MetricCard
                  label="Duplicate FRR"
                  value={c.duplicate_frr_rows}
                  tone={c.duplicate_frr_rows === 0 ? "ok" : "bad"}
                />
                <MetricCard
                  label="TRID collisions"
                  value={c.trid_collision_groups}
                  tone={c.trid_collision_groups === 0 ? "ok" : "bad"}
                />
                <MetricCard
                  label="Staging left"
                  value={c.staging_remaining}
                  tone={c.staging_remaining === 0 ? "ok" : "warn"}
                />
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">
                Each settlement line should map to one FRR row via{" "}
                <span className="font-mono">source_row_id</span>. Samples are capped at 50 per tab.
              </p>

              <div className="flex gap-1 border-b border-border">
                {(["matched", "unmatched", "conflicts"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={[
                      "px-3 py-1.5 text-xs font-medium capitalize",
                      tab === t
                        ? "border-b-2 border-primary text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    {t}
                    {t === "unmatched" && c.unmatched_settlement_rows > 0
                      ? ` (${c.unmatched_settlement_rows})`
                      : ""}
                  </button>
                ))}
              </div>

              {tab === "matched" && (
                <SampleTable
                  title="Matched sample"
                  rows={data.samples.matched}
                  empty="No matched samples returned."
                />
              )}
              {tab === "unmatched" && (
                <SampleTable
                  title="Unmatched sample"
                  rows={data.samples.unmatched}
                  empty="No unmatched lines in sample."
                />
              )}
              {tab === "conflicts" && (
                <SampleTable
                  title="Conflict sample"
                  rows={data.samples.conflicts}
                  empty="No conflicts in sample."
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
