"use client";

import { ChevronRight } from "lucide-react";

import { IdentifierStack } from "@/components/IdentifierStack";
import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  deriveNextAction,
  extractSourceTrackingLabel,
  formatTrackingMoney,
  familyTone,
  reimbursementTrackingStatusLabel,
  reimbursementTrackingStatusTone,
  shortId,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  CLAIM_CENTER_TABLE_CLASS,
  CLAIM_CENTER_TABLE_HEAD_CLASS,
  CLAIM_CENTER_TABLE_ROW_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";

type Props = {
  rows: ReimbursementTrackingPreviewRow[];
  selectedId: string | null;
  onSelect: (row: ReimbursementTrackingPreviewRow) => void;
  storePlatform?: string | null;
};

function MoneyCell({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span className="text-amber-700 dark:text-amber-300" title="Unknown values are not treated as zero.">
        Unknown
      </span>
    );
  }
  return <span className="tabular-nums">{formatTrackingMoney(value)}</span>;
}

function familyRowClass(family: string | null | undefined): string {
  const fam = (family ?? "").toLowerCase();
  if (fam.includes("removal_shipment_missing")) {
    return "border-l-4 border-l-violet-500/70";
  }
  if (fam.includes("removal_order_discrepancy")) {
    return "border-l-4 border-l-sky-500/70";
  }
  return "border-l-4 border-l-transparent";
}

export function ReimbursementTrackingTable({ rows, selectedId, onSelect, storePlatform }: Props) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm opacity-70">
        No results match these filters. Clear filters to see all submissions.
      </p>
    );
  }

  return (
    <div className="claim-center-table-card overflow-x-auto rounded-xl border">
      <table className={`${CLAIM_CENTER_TABLE_CLASS} min-w-[1100px]`}>
        <thead className={`${CLAIM_CENTER_TABLE_HEAD_CLASS} sticky top-0 z-10 bg-[var(--claim-center-card-bg,hsl(var(--card)))] text-xs uppercase opacity-70`}>
          <tr>
            <th className="px-3 py-3 text-left">Status</th>
            <th className="px-3 py-3 text-left">Family</th>
            <th className="px-3 py-3 text-left">Case</th>
            <th className="px-3 py-3 text-left">Submission</th>
            <th className="px-3 py-3 text-left">Product</th>
            <th className="px-3 py-3 text-left">Source / tracking</th>
            <th className="px-3 py-3 text-right">Qty</th>
            <th className="px-3 py-3 text-right">Est. recoverable</th>
            <th className="px-3 py-3 text-right">Observed</th>
            <th className="px-3 py-3 text-right">Open gap</th>
            <th className="px-3 py-3 text-left">Match</th>
            <th className="px-3 py-3 text-left">Next action</th>
            <th className="px-3 py-3 text-right"> </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const family = row.family_key_v3 ?? row.claim_family;
            const tone = reimbursementTrackingStatusTone(row.reimbursement_tracking_status);
            const famTone = familyTone(family);
            return (
              <tr
                key={row.claim_submission_id}
                className={`${CLAIM_CENTER_TABLE_ROW_CLASS} ${familyRowClass(family)} ${
                  idx % 2 === 1 ? "bg-black/[0.015] dark:bg-white/[0.015]" : ""
                } ${selectedId === row.claim_submission_id ? "bg-sky-500/10" : ""}`}
                onClick={() => onSelect(row)}
              >
                <td className="px-3 py-2.5">
                  <span className={claimCenterBadgeTone(tone)}>{reimbursementTrackingStatusLabel(row.reimbursement_tracking_status)}</span>
                </td>
                <td className="px-3 py-2.5">
                  <span className={claimCenterBadgeTone(famTone)}>{(family ?? "—").replace(/_/g, " ")}</span>
                </td>
                <td className="px-3 py-2.5 font-mono text-[10px]">{shortId(row.claim_case_id)}</td>
                <td className="px-3 py-2.5 font-mono text-[10px]">{shortId(row.claim_submission_id)}</td>
                <td className="px-3 py-2.5 min-w-[160px]">
                  <IdentifierStack
                    asin={row.asin}
                    fnsku={row.fnsku}
                    sku={row.sku}
                    storePlatform={storePlatform}
                    compact
                    hideItemName
                  />
                </td>
                <td className="px-3 py-2.5 max-w-[140px] truncate font-mono text-[10px]" title={extractSourceTrackingLabel(row)}>
                  {extractSourceTrackingLabel(row)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{row.clean_quantity ?? "—"}</td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={row.recovery_value ?? row.estimated_amount} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={row.observed_reimbursement} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs">
                  <MoneyCell value={row.financial_gap} />
                </td>
                <td className="px-3 py-2.5 text-xs capitalize">{row.match_confidence}</td>
                <td className="px-3 py-2.5 max-w-[160px] text-xs">{deriveNextAction(row)}</td>
                <td className="px-3 py-2.5 text-right">
                  <ChevronRight className="inline h-4 w-4 opacity-50" aria-hidden />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
