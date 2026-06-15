"use client";

import { Layers } from "lucide-react";

import type { GroupPreviewRow } from "@/lib/claims/grouping/claim-grouping-readmodel";
import { RECOMMENDED_ACTION_LABELS } from "@/lib/claims/grouping/claim-grouping-ui-contract";

import { formatNullableUsd, formatNullableUnits, shortId } from "./claim-grouping-format";
import { ClaimGroupWarningList } from "./ClaimGroupWarningList";

type Props = {
  group: GroupPreviewRow;
  selected?: boolean;
  onToggleSelect?: (previewIds: string[]) => void;
  selectable?: boolean;
};

function actionTone(action: GroupPreviewRow["recommended_action"]): string {
  if (action === "file_single" || action === "file_grouped") return "claim-center-badge--success";
  if (action === "split_group" || action === "needs_review") return "claim-center-badge--warn";
  return "claim-center-badge--muted";
}

export function ClaimGroupPreviewCard({ group, selected, onToggleSelect, selectable }: Props) {
  const productLabel =
    group.products.length === 1
      ? shortId(group.products[0] === "unlinked" ? null : group.products[0])
      : `${group.products.length} products`;

  return (
    <article
      className={`claim-center-card rounded-xl p-4 transition-shadow hover:shadow-md ${
        selected ? "ring-2 ring-primary/40" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
            <h3 className="truncate text-sm font-semibold">{group.group_title}</h3>
          </div>
          <p className="mt-1 text-[11px] opacity-60">
            {group.included_preview_ids.length} preview
            {group.included_preview_ids.length === 1 ? "" : "s"} · {group.grouping_mode.replace(/_/g, " ")}
          </p>
        </div>
        <span className={`claim-center-badge shrink-0 ${actionTone(group.recommended_action)}`}>
          {RECOMMENDED_ACTION_LABELS[group.recommended_action]}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="opacity-55">Products</dt>
          <dd className="font-medium">{productLabel}</dd>
        </div>
        <div>
          <dt className="opacity-55">Families</dt>
          <dd className="font-medium">{group.families.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt className="opacity-55">Units</dt>
          <dd className="font-medium tabular-nums">{formatNullableUnits(group.total_units)}</dd>
        </div>
        <div>
          <dt className="opacity-55">Observed reimb.</dt>
          <dd className="font-medium tabular-nums">{formatNullableUsd(group.observed_reimbursement_sum)}</dd>
        </div>
        <div>
          <dt className="opacity-55">Est. payout</dt>
          <dd className="font-medium tabular-nums">{formatNullableUsd(group.estimated_amazon_payout_sum)}</dd>
        </div>
        <div>
          <dt className="opacity-55">Internal cost</dt>
          <dd className="font-medium tabular-nums">{formatNullableUsd(group.internal_cost_loss_sum)}</dd>
        </div>
        <div className="col-span-2 sm:col-span-3">
          <dt className="opacity-55">Recovery gap</dt>
          <dd className="font-medium tabular-nums">{formatNullableUsd(group.reimbursement_gap_sum)}</dd>
        </div>
      </dl>

      {group.references.length ? (
        <div className="mt-3 text-[11px] opacity-75">
          <span className="font-semibold">References: </span>
          {group.references
            .slice(0, 3)
            .map((r) => `${r.kind} ${shortId(r.value)}`)
            .join(" · ")}
          {group.references.length > 3 ? ` +${group.references.length - 3}` : ""}
        </div>
      ) : null}

      <div className="mt-3">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-50">Warnings</p>
        <ClaimGroupWarningList warnings={group.warnings} compact />
      </div>

      {selectable && onToggleSelect ? (
        <button
          type="button"
          onClick={() => onToggleSelect(group.included_preview_ids)}
          className="mt-3 w-full rounded-lg border px-3 py-2 text-xs font-semibold transition-colors hover:bg-black/5 dark:hover:bg-white/5"
        >
          {selected ? "Deselect group" : "Select for manual group"}
        </button>
      ) : null}
    </article>
  );
}
