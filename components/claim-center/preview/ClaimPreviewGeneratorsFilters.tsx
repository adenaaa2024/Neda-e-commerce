"use client";

import { Filter } from "lucide-react";

import {
  CLAIM_CENTER_INPUT_CLASS,
  CLAIM_CENTER_SELECT_CLASS,
} from "@/components/claim-center/claim-center-ui";
import {
  DEFAULT_PREVIEW_GENERATORS_FILTER_STATE,
  PREVIEW_GENERATORS_FAMILY_OPTIONS,
  PREVIEW_GENERATORS_SOURCE_OPTIONS,
  PREVIEW_GENERATORS_STATUS_OPTIONS,
  type ClaimPreviewGeneratorsFilterState,
} from "@/lib/claims/preview/claim-preview-generators-ui-contract";

type Props = {
  filters: ClaimPreviewGeneratorsFilterState;
  onChange: (next: ClaimPreviewGeneratorsFilterState) => void;
  onApply: () => void;
  loading?: boolean;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="font-medium opacity-70">{label}</span>
      {children}
    </label>
  );
}

export function ClaimPreviewGeneratorsFilters({ filters, onChange, onApply, loading }: Props) {
  const patch = (partial: Partial<ClaimPreviewGeneratorsFilterState>) =>
    onChange({ ...filters, ...partial });

  const reset = () => onChange(DEFAULT_PREVIEW_GENERATORS_FILTER_STATE);

  return (
    <section className="claim-center-card space-y-4 rounded-xl p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Filter className="h-4 w-4 opacity-60" />
        Filters
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Family">
          <select
            className={`${CLAIM_CENTER_SELECT_CLASS} w-full`}
            value={filters.family_key}
            onChange={(e) => patch({ family_key: e.target.value })}
          >
            {PREVIEW_GENERATORS_FAMILY_OPTIONS.map((o) => (
              <option key={o.value || "any"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Status">
          <select
            className={`${CLAIM_CENTER_SELECT_CLASS} w-full`}
            value={filters.status}
            onChange={(e) =>
              patch({
                status: e.target.value as ClaimPreviewGeneratorsFilterState["status"],
                claim_ready_only: false,
                needs_review_only: false,
              })
            }
          >
            {PREVIEW_GENERATORS_STATUS_OPTIONS.map((o) => (
              <option key={o.value || "default"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Source">
          <select
            className={`${CLAIM_CENTER_SELECT_CLASS} w-full`}
            value={filters.source_kind}
            onChange={(e) => patch({ source_kind: e.target.value })}
          >
            {PREVIEW_GENERATORS_SOURCE_OPTIONS.map((o) => (
              <option key={o.value || "any"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Product (ID / ASIN / FNSKU / SKU)">
          <input
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.product_query}
            onChange={(e) => patch({ product_query: e.target.value })}
            placeholder="Search product identifiers"
          />
        </Field>

        <Field label="Date from">
          <input
            type="date"
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.date_from}
            onChange={(e) => patch({ date_from: e.target.value })}
          />
        </Field>

        <Field label="Date to">
          <input
            type="date"
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.date_to}
            onChange={(e) => patch({ date_to: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.claim_ready_only}
            onChange={(e) =>
              patch({
                claim_ready_only: e.target.checked,
                needs_review_only: e.target.checked ? false : filters.needs_review_only,
                status: e.target.checked ? "claim_ready" : "",
              })
            }
          />
          Claim ready only
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.needs_review_only}
            onChange={(e) =>
              patch({
                needs_review_only: e.target.checked,
                claim_ready_only: e.target.checked ? false : filters.claim_ready_only,
                status: e.target.checked ? "needs_review" : "",
              })
            }
          />
          Needs review only
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={loading}
          className="claim-center-btn rounded-lg px-4 py-2 text-xs font-semibold disabled:opacity-50"
        >
          Apply filters
        </button>
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border px-4 py-2 text-xs font-medium"
        >
          Reset
        </button>
      </div>
    </section>
  );
}
