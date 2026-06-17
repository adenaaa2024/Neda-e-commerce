"use client";

import type { ClaimPilotReviewRow } from "@/lib/claims/pilot/claim-pilot-review-readmodel";
import {
  CLAIM_CENTER_TABLE_CLASS,
  CLAIM_CENTER_TABLE_HEAD_CLASS,
  CLAIM_CENTER_TABLE_ROW_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";
import { formatPilotMoney, productIdentifierLabel } from "@/lib/claims/pilot/claim-pilot-review-ui-contract";

type Props = {
  rows: ClaimPilotReviewRow[];
  selectedId: string | null;
  checkedIds: Set<string>;
  onSelect: (row: ClaimPilotReviewRow) => void;
  onToggleCheck: (rowId: string, checked: boolean) => void;
  emptyLabel?: string;
};

export function ClaimPilotReviewTable({
  rows,
  selectedId,
  checkedIds,
  onSelect,
  onToggleCheck,
  emptyLabel = "No pilot candidates match these filters.",
}: Props) {
  return (
    <div className="claim-center-table-card overflow-x-auto rounded-xl border">
      <table className={CLAIM_CENTER_TABLE_CLASS}>
        <thead className={`${CLAIM_CENTER_TABLE_HEAD_CLASS} text-[10px] uppercase opacity-70`}>
          <tr>
            <th className="px-3 py-2 w-8">
              <span className="sr-only">Select</span>
            </th>
            <th className="px-3 py-2">Candidate ID</th>
            <th className="px-3 py-2">Family V3</th>
            <th className="px-3 py-2">Claim family</th>
            <th className="px-3 py-2">Source kind</th>
            <th className="px-3 py-2">Event key</th>
            <th className="px-3 py-2">Product</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Recovery</th>
            <th className="px-3 py-2 text-right">COGS</th>
            <th className="px-3 py-2">Event date</th>
            <th className="px-3 py-2">Date gate</th>
            <th className="px-3 py-2">Evidence</th>
            <th className="px-3 py-2">Edges</th>
            <th className="px-3 py-2">Pointers</th>
            <th className="px-3 py-2">Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={16} className="px-4 py-10 text-center text-sm opacity-60">
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const active = selectedId === row.id;
              return (
                <tr
                  key={row.id}
                  className={`${CLAIM_CENTER_TABLE_ROW_CLASS} cursor-pointer ${active ? "bg-sky-500/10" : ""}`}
                  onClick={() => onSelect(row)}
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checkedIds.has(row.id)}
                      onChange={(e) => onToggleCheck(row.id, e.target.checked)}
                      aria-label={`Select candidate ${row.id}`}
                      className="h-4 w-4 rounded border"
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px]">{row.id.slice(0, 8)}…</td>
                  <td className="px-3 py-2 text-xs">{row.family_key_v3?.replace(/_/g, " ") ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{row.claim_family ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{row.source_kind ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-[10px] max-w-[120px] truncate">
                    {row.source_event_key ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{productIdentifierLabel(row)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">
                    {row.expected_quantity ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {formatPilotMoney(row.recovery_value, row.currency)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {formatPilotMoney(row.cogs_unit, row.currency)}
                  </td>
                  <td className="px-3 py-2 text-xs">{row.source_event_date ?? row.event_date ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={claimCenterBadgeTone(row.date_gate_passed ? "success" : "warning")}
                    >
                      {row.date_gate_passed ? "Passed" : "Failed"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{row.evidence_status ?? "—"}</td>
                  <td className="px-3 py-2 text-xs tabular-nums">{row.reference_edges.length}</td>
                  <td className="px-3 py-2 text-xs tabular-nums">{row.evidence_pointers.length}</td>
                  <td className="px-3 py-2 text-xs">
                    {row.review_flags.length ? (
                      <span className={claimCenterBadgeTone("warning")}>{row.review_flags.length}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
