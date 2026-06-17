"use client";

import type { ClaimCaseReviewFilterState } from "@/lib/claims/pilot/claim-case-review-ui-contract";
import {
  CASE_REVIEW_FAMILY_OPTIONS,
  CASE_REVIEW_STATUS_OPTIONS,
} from "@/lib/claims/pilot/claim-case-review-ui-contract";

type Props = {
  filters: ClaimCaseReviewFilterState;
  onChange: (next: ClaimCaseReviewFilterState) => void;
  onApply: () => void;
  onReset: () => void;
};

const inputClass =
  "w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm dark:border-white/10";

export function ClaimCaseReviewFilters({ filters, onChange, onApply, onReset }: Props) {
  const set = <K extends keyof ClaimCaseReviewFilterState>(key: K, value: ClaimCaseReviewFilterState[K]) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div className="claim-center-card space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Case review filters</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border px-3 py-1.5 text-xs font-semibold opacity-80 hover:opacity-100"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onApply}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
          >
            Apply filters
          </button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-xs sm:col-span-2">
          <span className="mb-1 block font-medium opacity-70">Pilot case run ID</span>
          <input
            className={`${inputClass} font-mono text-[11px]`}
            value={filters.pilot_case_run_id}
            onChange={(e) => set("pilot_case_run_id", e.target.value)}
            readOnly
            title="Locked to pilot execute run"
          />
        </label>
        <label className="block text-xs sm:col-span-2">
          <span className="mb-1 block font-medium opacity-70">Intake run ID</span>
          <input
            className={`${inputClass} font-mono text-[11px]`}
            value={filters.intake_run_id}
            onChange={(e) => set("intake_run_id", e.target.value)}
            readOnly
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium opacity-70">Family (V3)</span>
          <select
            className={inputClass}
            value={filters.family_key_v3}
            onChange={(e) => set("family_key_v3", e.target.value)}
          >
            <option value="">All families</option>
            {CASE_REVIEW_FAMILY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium opacity-70">Claim family</span>
          <input
            className={inputClass}
            value={filters.claim_family}
            onChange={(e) => set("claim_family", e.target.value)}
            placeholder="e.g. shipment_not_received"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium opacity-70">Case status</span>
          <select
            className={inputClass}
            value={filters.status}
            onChange={(e) => set("status", e.target.value)}
          >
            {CASE_REVIEW_STATUS_OPTIONS.map((o) => (
              <option key={o.value || "all"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium opacity-70">Source event key</span>
          <input
            className={inputClass}
            value={filters.source_event_key}
            onChange={(e) => set("source_event_key", e.target.value)}
            placeholder="Tracking or shipment id"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium opacity-70">Product (SKU / FNSKU / ASIN)</span>
          <input
            className={inputClass}
            value={filters.product_query}
            onChange={(e) => set("product_query", e.target.value)}
            placeholder="Search identifiers"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium opacity-70">Date from</span>
          <input
            type="date"
            className={inputClass}
            value={filters.date_from}
            onChange={(e) => set("date_from", e.target.value)}
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium opacity-70">Date to</span>
          <input
            type="date"
            className={inputClass}
            value={filters.date_to}
            onChange={(e) => set("date_to", e.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
