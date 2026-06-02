"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";

import { ClaimSourceBadge } from "@/components/claim-engine/ClaimSourceBadge";
import { ClaimEngineEmptyState } from "@/components/claim-engine/ClaimEngineEmptyState";

export type PhysicalReturnPreviewRow = {
  return_item_id: string;
  store_id: string | null;
  created_at: string | null;
  queue_state: string;
  state_label: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  item_name: string | null;
  scanner_issue_label: string | null;
  claim_case_id: string | null;
  flow_stage_label: string | null;
};

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
    new Date(t),
  );
}

export function ClaimIntakePhysicalReturnsSection(props: {
  loading: boolean;
  error: string | null;
  rows: PhysicalReturnPreviewRow[];
  totalCount: number;
  compact?: boolean;
}) {
  const { loading, error, rows, totalCount, compact } = props;

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-sky-200/60 bg-sky-50/50 px-3 py-6 text-xs text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/20 dark:text-sky-100">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading physical returns…
      </div>
    );
  }

  if (error) {
    return (
      <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
        {error}
      </p>
    );
  }

  if (!rows.length) {
    return (
      <ClaimEngineEmptyState
        title="No physical returns in draft pool"
        description="Warehouse scans with claimable conditions appear here before they enter claim_candidates."
        action={{ href: "/scanner/operator-mobile/scan", label: "Open scanner" }}
        secondaryAction={{ href: "/returns/claims", label: "Draft pool" }}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-sky-200/70 bg-sky-50/30 dark:border-sky-900/50 dark:bg-sky-950/15">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sky-200/60 px-3 py-2 dark:border-sky-900/50">
        <div className="flex items-center gap-2">
          <ClaimSourceBadge kind="physical_return" />
          <span className="text-xs font-medium text-slate-800 dark:text-slate-100">
            Draft pool · {totalCount} row{totalCount === 1 ? "" : "s"}
            {compact && rows.length < totalCount ? ` (showing ${rows.length})` : null}
          </span>
        </div>
        <Link href="/returns/claims" className="text-[11px] font-medium text-sky-700 underline dark:text-sky-300">
          Open draft pool →
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-[11px]">
          <thead className="border-b border-sky-200/50 bg-white/60 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-sky-900/40 dark:bg-slate-950/40">
            <tr>
              <th className="px-3 py-1.5">State</th>
              <th className="px-3 py-1.5">Issue</th>
              <th className="px-3 py-1.5">Identifiers</th>
              <th className="px-3 py-1.5">Draft case</th>
              <th className="px-3 py-1.5">Scanned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.return_item_id}
                className="border-b border-sky-100/80 last:border-0 dark:border-sky-900/30"
              >
                <td className="px-3 py-1.5 align-top">{r.state_label}</td>
                <td className="px-3 py-1.5 align-top text-muted-foreground">{r.scanner_issue_label ?? "—"}</td>
                <td className="px-3 py-1.5 align-top">
                  <div className="line-clamp-1 font-medium">{r.item_name ?? r.sku ?? "—"}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {[r.sku, r.fnsku, r.asin].filter(Boolean).join(" · ") || "—"}
                  </div>
                </td>
                <td className="px-3 py-1.5 align-top font-mono text-[10px]">
                  {r.claim_case_id ? `${r.claim_case_id.slice(0, 8)}…` : "—"}
                  {r.flow_stage_label ? (
                    <div className="font-sans text-muted-foreground">{r.flow_stage_label}</div>
                  ) : null}
                </td>
                <td className="px-3 py-1.5 align-top text-muted-foreground">{formatWhen(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
