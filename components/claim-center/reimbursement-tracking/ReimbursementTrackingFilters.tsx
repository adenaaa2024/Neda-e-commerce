"use client";

import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import type { ReimbursementTrackingFilterState } from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  DEFAULT_REIMBURSEMENT_TRACKING_FILTERS,
  activeFilterChips,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  CLAIM_CENTER_INPUT_CLASS,
  CLAIM_CENTER_SELECT_CLASS,
} from "@/components/claim-center/claim-center-ui";

type Props = {
  filters: ReimbursementTrackingFilterState;
  rows: ReimbursementTrackingPreviewRow[];
  onChange: (next: ReimbursementTrackingFilterState) => void;
  onApply: () => void;
  onReset: () => void;
  onRemoveChip: (key: keyof ReimbursementTrackingFilterState) => void;
};

function uniqueValues(rows: ReimbursementTrackingPreviewRow[], pick: (r: ReimbursementTrackingPreviewRow) => string | null) {
  return [...new Set(rows.map(pick).filter(Boolean) as string[])].sort();
}

export function ReimbursementTrackingFilters({
  filters,
  rows,
  onChange,
  onApply,
  onReset,
  onRemoveChip,
}: Props) {
  const families = uniqueValues(rows, (r) => r.family_key_v3 ?? r.claim_family);
  const statuses = uniqueValues(rows, (r) => r.submission_status);
  const chips = activeFilterChips(filters);

  return (
    <section className="claim-center-card space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[140px] flex-1 text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">Family</span>
          <select
            className={CLAIM_CENTER_SELECT_CLASS}
            value={filters.family_key_v3}
            onChange={(e) => onChange({ ...filters, family_key_v3: e.target.value })}
          >
            <option value="">All families</option>
            {families.map((f) => (
              <option key={f} value={f}>
                {f.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-[140px] flex-1 text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">Submission status</span>
          <select
            className={CLAIM_CENTER_SELECT_CLASS}
            value={filters.submission_status}
            onChange={(e) => onChange({ ...filters, submission_status: e.target.value })}
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-[120px] text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">Matched</span>
          <select
            className={CLAIM_CENTER_SELECT_CLASS}
            value={filters.matched}
            onChange={(e) =>
              onChange({ ...filters, matched: e.target.value as ReimbursementTrackingFilterState["matched"] })
            }
          >
            <option value="">Any</option>
            <option value="matched">Matched</option>
            <option value="unmatched">Unmatched</option>
          </select>
        </label>

        <label className="min-w-[120px] text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">Follow-up</span>
          <select
            className={CLAIM_CENTER_SELECT_CLASS}
            value={filters.needs_follow_up}
            onChange={(e) =>
              onChange({
                ...filters,
                needs_follow_up: e.target.value as ReimbursementTrackingFilterState["needs_follow_up"],
              })
            }
          >
            <option value="">Any</option>
            <option value="yes">Needs follow-up</option>
            <option value="no">No follow-up</option>
          </select>
        </label>

        <label className="min-w-[120px] text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">Money</span>
          <select
            className={CLAIM_CENTER_SELECT_CLASS}
            value={filters.money_known}
            onChange={(e) =>
              onChange({
                ...filters,
                money_known: e.target.value as ReimbursementTrackingFilterState["money_known"],
              })
            }
          >
            <option value="">Any</option>
            <option value="known">Known</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>

        <label className="min-w-[120px] text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">Confidence</span>
          <select
            className={CLAIM_CENTER_SELECT_CLASS}
            value={filters.match_confidence}
            onChange={(e) =>
              onChange({
                ...filters,
                match_confidence: e.target.value as ReimbursementTrackingFilterState["match_confidence"],
              })
            }
          >
            <option value="">Any</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="none">None</option>
          </select>
        </label>

        <label className="min-w-[120px] text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">From date</span>
          <input
            type="date"
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.date_from}
            onChange={(e) => onChange({ ...filters, date_from: e.target.value })}
          />
        </label>

        <label className="min-w-[120px] text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">To date</span>
          <input
            type="date"
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.date_to}
            onChange={(e) => onChange({ ...filters, date_to: e.target.value })}
          />
        </label>

        <label className="min-w-[180px] flex-[2] text-xs">
          <span className="mb-1 block font-semibold uppercase opacity-60">Search</span>
          <input
            className={CLAIM_CENTER_INPUT_CLASS}
            placeholder="Case, submission, ASIN, FNSKU, SKU, tracking…"
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") onApply();
            }}
          />
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onApply}
            className="claim-center-btn claim-center-btn--primary rounded-lg px-4 py-2 text-xs font-semibold"
          >
            Apply filters
          </button>
          <button
            type="button"
            onClick={onReset}
            className="claim-center-btn rounded-lg border px-4 py-2 text-xs font-semibold opacity-80"
          >
            Clear filters
          </button>
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => onRemoveChip(chip.key)}
              className="inline-flex items-center gap-1 rounded-full border bg-black/5 px-2.5 py-1 text-[11px] font-medium dark:bg-white/5"
            >
              {chip.label}
              <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export { DEFAULT_REIMBURSEMENT_TRACKING_FILTERS };
