"use client";

import { ChevronRight } from "lucide-react";

import {
  attentionNextStepLabel,
  formatExposureLabel,
  humanCandidateLabel,
} from "@/lib/claims/center/claim-center-money-contract";
import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { ClaimCenterMobileCards } from "./ClaimCenterMobileCards";
import { ClaimCenterTwinSourceChips } from "./ClaimCenterTwinSourceChips";
import { claimCenterBadgeTone } from "./claim-center-ui";

type Props = {
  rows: ClaimCenterV1Row[];
  onSelect?: (row: ClaimCenterV1Row) => void;
};

function sourceLabel(row: ClaimCenterV1Row): string {
  return row.badges.find((b) => b.kind === "source")?.label ?? row.source_kind ?? "—";
}

function familyLabel(row: ClaimCenterV1Row): string {
  return row.claim_family?.replace(/_/g, " ") ?? "Opportunity";
}

export function ClaimCenterAttentionList({ rows, onSelect }: Props) {
  return (
    <div data-claim-center="attention-list">
      <div className="hidden md:block claim-center-table-card overflow-hidden transition-shadow hover:shadow-md">
        <table className="claim-center-table w-full text-sm">
          <thead className="text-xs uppercase opacity-70">
            <tr>
              <th className="px-4 py-3 text-left">Item</th>
              <th className="px-4 py-3 text-left">Family / source</th>
              <th className="px-4 py-3 text-left">Deadline</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Exposure</th>
              <th className="px-4 py-3 text-right">Next</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const deadlineTone =
                r.canonical_window.status === "expired"
                  ? "danger"
                  : r.canonical_window.status === "closing_soon"
                    ? "warning"
                    : "neutral";
              return (
                <tr
                  key={r.id}
                  className="claim-center-attention-row cursor-pointer border-t transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => onSelect?.(r)}
                >
                  <td className="px-4 py-3 font-medium">{humanCandidateLabel(r)}</td>
                  <td className="px-4 py-3 text-xs opacity-80">
                    <div>{familyLabel(r)}</div>
                    <ClaimCenterTwinSourceChips row={r} className="mt-1" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs font-medium">{r.eligibility_display?.label ?? "—"}</div>
                    <span className={`mt-1 inline-block ${claimCenterBadgeTone(deadlineTone)}`}>
                      {r.canonical_window.deadline ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">{r.v1_status_label}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{formatExposureLabel(r)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex items-center gap-0.5 text-xs font-semibold opacity-70">
                      {attentionNextStepLabel(r)}
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="md:hidden">
        <ClaimCenterMobileCards rows={rows} onSelect={onSelect} />
      </div>
    </div>
  );
}
