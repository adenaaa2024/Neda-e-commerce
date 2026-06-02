"use client";

import { AlertTriangle, Loader2, Scissors, X } from "lucide-react";

import {
  analyzeCaseBuilderWarnings,
  splitSelectionByDimension,
  type CaseBuilderWarning,
} from "@/lib/claim-case-builder-warnings";
import type { EffectiveClaimSettingsSnapshot } from "@/lib/claim-effective-settings-shared";
import type { ClaimPolicyV1 } from "@/lib/claim-policy-types";
import type { ManualGroupingDimension } from "@/lib/returns-manual-claim-grouping";
import type { ReturnsClaimQueueRow } from "@/lib/returns-claims-work-queue";
import {
  CLAIM_ENGINE_BTN_PRIMARY,
  CLAIM_ENGINE_BTN_SECONDARY,
  CLAIM_ENGINE_SECTION_CLASS,
} from "./claim-engine-ui";

const SPLIT_DIMENSIONS: { id: ManualGroupingDimension; label: string }[] = [
  { id: "product", label: "Product" },
  { id: "issue", label: "Issue" },
  { id: "package", label: "Package" },
  { id: "pallet", label: "Pallet" },
  { id: "order", label: "Order" },
];

function warningClass(w: CaseBuilderWarning): string {
  if (w.severity === "block") return "text-rose-700 dark:text-rose-300";
  if (w.severity === "warn") return "text-amber-800 dark:text-amber-200";
  return "text-muted-foreground";
}

export function ClaimCaseBuilderPanel({
  open,
  rows,
  policy,
  effectiveSettings,
  creating,
  onClose,
  onConfirmMixed,
  onSplitAndCreate,
  onRemoveRow,
}: {
  open: boolean;
  rows: ReturnsClaimQueueRow[];
  policy: ClaimPolicyV1 | null | undefined;
  effectiveSettings?: EffectiveClaimSettingsSnapshot | null;
  creating: boolean;
  onClose: () => void;
  onConfirmMixed: () => void;
  onSplitAndCreate: (dimension: ManualGroupingDimension) => void;
  onRemoveRow: (returnItemId: string) => void;
}) {
  if (!open) return null;

  const { warnings, blocking } = analyzeCaseBuilderWarnings(rows, policy, effectiveSettings, policy);
  const splitPreview = splitSelectionByDimension(rows, "product");

  return (
    <div
      className="fixed inset-0 z-[460] flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-labelledby="case-builder-title"
    >
      <div className="flex max-h-[min(90vh,720px)] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-950 sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <h2 id="case-builder-title" className="text-base font-bold text-slate-900 dark:text-slate-50">
              Case builder
            </h2>
            <p className="text-xs text-muted-foreground">
              {rows.length} item{rows.length === 1 ? "" : "s"} — creates claim_case + claim_lines on confirm (no marketplace submit).
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {warnings.length ? (
            <ul className={`${CLAIM_ENGINE_SECTION_CLASS} space-y-2`}>
              {warnings.map((w) => (
                <li key={`${w.code}-${w.message}`} className={`flex gap-2 text-xs ${warningClass(w)}`}>
                  {w.severity !== "info" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
                  {w.message}
                </li>
              ))}
            </ul>
          ) : null}

          <ul className="space-y-2 text-sm">
            {rows.map((row) => (
              <li
                key={row.return_item_id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 dark:border-slate-800"
              >
                <span className="min-w-0 truncate">
                  {row.item_name?.trim() || row.lpn || row.return_item_id.slice(0, 8)} · {row.state_label}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveRow(row.return_item_id)}
                  className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          {splitPreview.length > 1 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Split automatically</p>
              <div className="flex flex-wrap gap-2">
                {SPLIT_DIMENSIONS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    disabled={creating}
                    onClick={() => onSplitAndCreate(d.id)}
                    className={`${CLAIM_ENGINE_BTN_SECONDARY} inline-flex items-center gap-1`}
                  >
                    <Scissors className="h-3.5 w-3.5" />
                    By {d.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Creates one case per {splitPreview.length} product group(s) when splitting by product (preview count).
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-200 px-4 py-3 sm:flex-row sm:justify-end dark:border-slate-800">
          <button type="button" onClick={onClose} className={CLAIM_ENGINE_BTN_SECONDARY}>
            Cancel
          </button>
          <button
            type="button"
            disabled={creating || blocking || !rows.length}
            onClick={onConfirmMixed}
            className={`${CLAIM_ENGINE_BTN_PRIMARY} inline-flex items-center justify-center gap-2`}
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Confirm — create case
          </button>
        </div>
      </div>
    </div>
  );
}
