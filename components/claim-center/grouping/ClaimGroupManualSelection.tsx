"use client";

import { useMemo } from "react";
import { Hand, Loader2 } from "lucide-react";

import type { GroupPreviewRow } from "@/lib/claims/grouping/claim-grouping-readmodel";

import { ClaimGroupPreviewCard } from "./ClaimGroupPreviewCard";

type Props = {
  rowGroups: GroupPreviewRow[];
  selectedPreviewIds: Set<string>;
  onTogglePreviewId: (previewId: string) => void;
  onClearSelection: () => void;
  onPreviewManualGroup: () => void;
  manualPreview: GroupPreviewRow | null;
  manualLoading: boolean;
};

export function ClaimGroupManualSelection({
  rowGroups,
  selectedPreviewIds,
  onTogglePreviewId,
  onClearSelection,
  onPreviewManualGroup,
  manualPreview,
  manualLoading,
}: Props) {
  const selectableRows = useMemo(
    () =>
      rowGroups.filter(
        (g) => g.grouping_mode === "one_candidate_per_group" && g.included_preview_ids.length === 1,
      ),
    [rowGroups],
  );

  return (
    <section className="claim-center-card space-y-4 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Hand className="h-4 w-4 opacity-60" />
          Manual selection
        </div>
        <p className="text-xs opacity-65">
          {selectedPreviewIds.size} selected · preview only, no save
        </p>
      </div>

      <p className="text-xs opacity-70">
        Select individual preview rows, then preview how they would group. Warnings surface mixed products,
        families, references, disputed rows, and policy holds.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onPreviewManualGroup}
          disabled={selectedPreviewIds.size === 0 || manualLoading}
          className="claim-center-btn rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
        >
          {manualLoading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Previewing…
            </span>
          ) : (
            "Preview manual group"
          )}
        </button>
        <button
          type="button"
          onClick={onClearSelection}
          disabled={selectedPreviewIds.size === 0}
          className="rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-50"
        >
          Clear selection
        </button>
      </div>

      {selectableRows.length ? (
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-2">
          {selectableRows.map((g) => {
            const id = g.included_preview_ids[0]!;
            const checked = selectedPreviewIds.has(id);
            return (
              <label
                key={id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-black/5 dark:hover:bg-white/5 ${
                  checked ? "bg-primary/5" : ""
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked}
                  onChange={() => onTogglePreviewId(id)}
                />
                <span className="min-w-0 flex-1 text-xs">
                  <span className="font-semibold">{g.group_title}</span>
                  <span className="block opacity-65">
                    {g.families.join(", ")} · {g.recommended_action.replace(/_/g, " ")}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <p className="text-xs opacity-60">
          Switch grouping mode to &quot;One candidate per group&quot; and apply filters to load selectable rows.
        </p>
      )}

      {manualPreview ? (
        <div className="space-y-2 border-t pt-4">
          <h4 className="text-sm font-semibold">Manual group preview</h4>
          <ClaimGroupPreviewCard group={manualPreview} />
        </div>
      ) : null}
    </section>
  );
}
