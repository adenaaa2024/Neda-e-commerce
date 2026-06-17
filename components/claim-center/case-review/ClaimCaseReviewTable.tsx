"use client";

import type { ClaimCaseReviewRow } from "@/lib/claims/pilot/claim-case-review-readmodel";
import { formatCaseReviewMoney } from "@/lib/claims/pilot/claim-case-review-ui-contract";

type Props = {
  rows: ClaimCaseReviewRow[];
  onSelect: (row: ClaimCaseReviewRow) => void;
  selectedId: string | null;
};

function productLabel(row: ClaimCaseReviewRow): string {
  const parts = [row.sku, row.fnsku, row.asin].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function moneySummary(row: ClaimCaseReviewRow): string {
  const lanes = row.money_lanes;
  const parts: string[] = [];
  if (lanes.estimated_amazon_payout != null) {
    parts.push(`est ${formatCaseReviewMoney(lanes.estimated_amazon_payout)}`);
  }
  if (lanes.observed_reimbursement != null) {
    parts.push(`obs ${formatCaseReviewMoney(lanes.observed_reimbursement)}`);
  }
  if (lanes.internal_cost_loss != null) {
    parts.push(`cost ${formatCaseReviewMoney(lanes.internal_cost_loss)}`);
  }
  return parts.length > 0 ? parts.join("; ") : "NULL lanes";
}

export function ClaimCaseReviewTable({ rows, onSelect, selectedId }: Props) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm opacity-60">
        No pilot cases match the current filters.
      </p>
    );
  }

  return (
    <>
      <div className="hidden md:block claim-center-table-card overflow-x-auto">
        <table className="claim-center-table w-full text-sm">
          <thead className="text-xs uppercase opacity-70">
            <tr>
              <th className="px-4 py-3 text-left">Case ID</th>
              <th className="px-4 py-3 text-left">Family</th>
              <th className="px-4 py-3 text-left">Source event</th>
              <th className="px-4 py-3 text-left">Candidates</th>
              <th className="px-4 py-3 text-left">Product</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-left">Money</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={`border-t cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 ${
                  selectedId === row.id ? "bg-sky-500/10" : ""
                }`}
                onClick={() => onSelect(row)}
              >
                <td className="px-4 py-3 font-mono text-[10px]">{row.id.slice(0, 8)}…</td>
                <td className="px-4 py-3 text-xs">{row.family_key_v3 ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-[10px] max-w-[140px] truncate">
                  {row.source_event_key ?? "—"}
                </td>
                <td className="px-4 py-3 font-mono text-[10px]">
                  {row.candidate_ids[0]?.slice(0, 8) ?? "—"}…
                </td>
                <td className="px-4 py-3 text-xs max-w-[160px] truncate">{productLabel(row)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.quantity_expected ?? row.clean_quantity ?? "—"}
                </td>
                <td className="px-4 py-3 text-xs max-w-[180px] truncate">{moneySummary(row)}</td>
                <td className="px-4 py-3 text-xs">{row.status ?? "—"}</td>
                <td className="px-4 py-3 text-xs whitespace-nowrap">
                  {row.created_at?.slice(0, 10) ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onSelect(row)}
              className={`claim-center-mobile-card w-full p-4 text-left text-sm ${
                selectedId === row.id ? "ring-2 ring-violet-500/40" : ""
              }`}
            >
              <p className="font-mono text-[10px]">{row.id}</p>
              <p className="mt-1 font-semibold">{row.family_key_v3 ?? "—"}</p>
              <p className="mt-1 text-xs opacity-70">{row.source_event_key ?? "—"}</p>
              <p className="mt-2 text-xs">
                Qty {row.quantity_expected ?? "—"} · {row.status ?? "—"}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
