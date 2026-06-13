"use client";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { CLAIM_CENTER_TABLE_CLASS, CLAIM_CENTER_TABLE_HEAD_CLASS, CLAIM_CENTER_TABLE_ROW_CLASS, claimCenterBadgeTone } from "./claim-center-ui";

type Props = {
  rows: ClaimCenterV1Row[];
  onSelect?: (row: ClaimCenterV1Row) => void;
  emptyLabel?: string;
};

function moneyLabel(row: ClaimCenterV1Row): string {
  return row.money_display?.amount_display_label ?? "Cost unknown";
}

export function ClaimCenterListTable({ rows, onSelect, emptyLabel = "No items in scope." }: Props) {
  return (
    <div className="claim-center-table-card hidden overflow-x-auto lg:block">
      <table className={CLAIM_CENTER_TABLE_CLASS}>
        <thead className={`${CLAIM_CENTER_TABLE_HEAD_CLASS} text-xs uppercase opacity-70`}>
          <tr>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Product</th>
            <th className="px-4 py-3">Reference</th>
            <th className="px-4 py-3">Evidence</th>
            <th className="px-4 py-3">Deadline</th>
            <th className="px-4 py-3 text-right">Recovery</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-10 text-center opacity-60">
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const source = row.badges.find((b) => b.kind === "source")?.label ?? "—";
              const product = row.badges.find((b) => b.kind === "product")?.label ?? "—";
              const trid = row.badges.find((b) => b.kind === "trid")?.label ?? "—";
              const evidence = row.badges.find((b) => b.kind === "evidence")?.label ?? "—";
              const deadline = row.badges.find((b) => b.kind === "deadline")?.label ?? "—";
              return (
                <tr key={row.id} className={CLAIM_CENTER_TABLE_ROW_CLASS} onClick={() => onSelect?.(row)}>
                  <td className="px-4 py-3">
                    <span className={claimCenterBadgeTone("info")}>{source}</span>
                  </td>
                  <td className="px-4 py-3 text-xs">{product}</td>
                  <td className="px-4 py-3 text-xs">
                    {row.ambiguity_pending ? (
                      <span className={claimCenterBadgeTone("danger")}>Conflict</span>
                    ) : (
                      trid
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">{evidence}</td>
                  <td className="px-4 py-3 text-xs">{deadline}</td>
                  <td className="px-4 py-3 text-right font-medium" title={row.money_display?.amount_tooltip}>
                    {moneyLabel(row)}
                  </td>
                  <td className="px-4 py-3 text-xs">{row.v1_status_label}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
