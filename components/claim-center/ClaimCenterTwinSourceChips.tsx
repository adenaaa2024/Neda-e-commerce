"use client";

import { twinSourceChipLabel } from "@/lib/claims/center/claim-center-twin-grouping";
import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { claimCenterBadgeTone } from "./claim-center-ui";

type Props = {
  row: ClaimCenterV1Row;
  className?: string;
};

export function ClaimCenterTwinSourceChips({ row, className = "" }: Props) {
  const kinds = row.twin_source_kinds?.length
    ? row.twin_source_kinds
    : row.source_kind
      ? [row.source_kind]
      : [];
  if (kinds.length <= 1 && !row.is_twin_primary) return null;

  return (
    <div className={`flex flex-wrap gap-1 ${className}`} data-claim-center="twin-source-chips">
      {kinds.map((k) => (
        <span key={k} className={claimCenterBadgeTone("info")}>
          {twinSourceChipLabel(k)}
        </span>
      ))}
      {row.is_twin_primary && kinds.length > 1 ? (
        <span className="text-[10px] opacity-50">grouped display</span>
      ) : null}
    </div>
  );
}
