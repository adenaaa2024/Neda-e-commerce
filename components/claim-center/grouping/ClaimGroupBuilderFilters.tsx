"use client";

import { Filter, X } from "lucide-react";

import {
  CLAIM_CENTER_INPUT_CLASS,
  CLAIM_CENTER_SELECT_CLASS,
} from "@/components/claim-center/claim-center-ui";
import type { ClaimGroupBuilderFilterState } from "@/lib/claims/grouping/claim-grouping-ui-contract";
import {
  CONFIDENCE_FILTER_OPTIONS,
  DEFAULT_GROUP_BUILDER_FILTER_STATE,
  FAMILY_FILTER_OPTIONS,
  REFERENCE_KIND_OPTIONS,
  SOURCE_KIND_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
} from "@/lib/claims/grouping/claim-grouping-ui-contract";

type Props = {
  filters: ClaimGroupBuilderFilterState;
  onChange: (next: ClaimGroupBuilderFilterState) => void;
  onApply: () => void;
  loading?: boolean;
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="font-medium opacity-70">{label}</span>
      {children}
    </label>
  );
}

export function ClaimGroupBuilderFilters({ filters, onChange, onApply, loading }: Props) {
  const patch = (partial: Partial<ClaimGroupBuilderFilterState>) => onChange({ ...filters, ...partial });

  const activeChips: Array<{ key: string; label: string; clear: () => void }> = [];
  const chip = (key: keyof ClaimGroupBuilderFilterState, label: string) => {
    const v = filters[key];
    if (typeof v === "boolean") {
      if (v) activeChips.push({ key, label, clear: () => patch({ [key]: false } as Partial<ClaimGroupBuilderFilterState>) });
      return;
    }
    const s = String(v).trim();
    if (s) activeChips.push({ key, label: `${label}: ${s}`, clear: () => patch({ [key]: "" } as Partial<ClaimGroupBuilderFilterState>) });
  };

  chip("product_id", "Product");
  chip("asin", "ASIN");
  chip("fnsku", "FNSKU");
  chip("sku", "SKU");
  chip("family_key", "Family");
  chip("source_kind", "Source");
  chip("status", "Status");
  chip("confidence", "Confidence");
  if (filters.reference_kind || filters.reference_value) {
    activeChips.push({
      key: "reference",
      label: `Ref: ${filters.reference_kind || "?"} ${filters.reference_value || ""}`.trim(),
      clear: () => patch({ reference_kind: "", reference_value: "" }),
    });
  }
  chip("shipment_id", "Shipment");
  chip("removal_order_id", "Removal order");
  chip("removal_shipment_id", "Removal shipment");
  chip("tracking_number", "Tracking");
  if (filters.date_from || filters.date_to) {
    activeChips.push({
      key: "date",
      label: `Dates: ${filters.date_from || "…"} – ${filters.date_to || "…"}`,
      clear: () => patch({ date_from: "", date_to: "" }),
    });
  }
  chip("min_estimated_payout", "Min payout");
  chip("min_observed_reimbursement", "Min reimb.");
  if (filters.include_needs_review) {
    activeChips.push({
      key: "include_needs_review",
      label: "Include needs review",
      clear: () => patch({ include_needs_review: false }),
    });
  }
  if (filters.include_unavailable) {
    activeChips.push({
      key: "include_unavailable",
      label: "Include unavailable",
      clear: () => patch({ include_unavailable: false }),
    });
  }

  return (
    <section className="claim-center-card space-y-4 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Filter className="h-4 w-4 opacity-60" />
          Filters
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onChange(DEFAULT_GROUP_BUILDER_FILTER_STATE)}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium opacity-80 hover:opacity-100"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={loading}
            className="claim-center-btn rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          >
            Apply filters
          </button>
        </div>
      </div>

      {activeChips.length ? (
        <div className="flex flex-wrap gap-2">
          {activeChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.clear}
              className="inline-flex items-center gap-1 rounded-full border bg-black/5 px-2.5 py-1 text-[11px] font-medium dark:bg-white/10"
            >
              {c.label}
              <X className="h-3 w-3 opacity-60" />
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs opacity-60">Default: claim-ready previews only. Toggle status chips or include flags below.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Field label="Product ID">
          <input
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.product_id}
            onChange={(e) => patch({ product_id: e.target.value })}
            placeholder="UUID"
          />
        </Field>
        <Field label="ASIN">
          <input className={CLAIM_CENTER_INPUT_CLASS} value={filters.asin} onChange={(e) => patch({ asin: e.target.value })} />
        </Field>
        <Field label="FNSKU">
          <input className={CLAIM_CENTER_INPUT_CLASS} value={filters.fnsku} onChange={(e) => patch({ fnsku: e.target.value })} />
        </Field>
        <Field label="SKU">
          <input className={CLAIM_CENTER_INPUT_CLASS} value={filters.sku} onChange={(e) => patch({ sku: e.target.value })} />
        </Field>
        <Field label="Claim family">
          <select
            className={`${CLAIM_CENTER_SELECT_CLASS} w-full`}
            value={filters.family_key}
            onChange={(e) => patch({ family_key: e.target.value })}
          >
            {FAMILY_FILTER_OPTIONS.map((o) => (
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
            onChange={(e) => patch({ status: e.target.value as ClaimGroupBuilderFilterState["status"] })}
          >
            {STATUS_FILTER_OPTIONS.map((o) => (
              <option key={o.value || "default"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Confidence">
          <select
            className={`${CLAIM_CENTER_SELECT_CLASS} w-full`}
            value={filters.confidence}
            onChange={(e) => patch({ confidence: e.target.value })}
          >
            {CONFIDENCE_FILTER_OPTIONS.map((o) => (
              <option key={o.value || "any"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source kind">
          <select
            className={`${CLAIM_CENTER_SELECT_CLASS} w-full`}
            value={filters.source_kind}
            onChange={(e) => patch({ source_kind: e.target.value })}
          >
            {SOURCE_KIND_FILTER_OPTIONS.map((o) => (
              <option key={o.value || "any"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference kind">
          <select
            className={`${CLAIM_CENTER_SELECT_CLASS} w-full`}
            value={filters.reference_kind}
            onChange={(e) => patch({ reference_kind: e.target.value })}
          >
            {REFERENCE_KIND_OPTIONS.map((o) => (
              <option key={o.value || "any"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference / TRID value">
          <input
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.reference_value}
            onChange={(e) => patch({ reference_value: e.target.value })}
            placeholder="ID or tracking"
          />
        </Field>
        <Field label="Shipment ID">
          <input
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.shipment_id}
            onChange={(e) => patch({ shipment_id: e.target.value })}
          />
        </Field>
        <Field label="Removal order">
          <input
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.removal_order_id}
            onChange={(e) => patch({ removal_order_id: e.target.value })}
          />
        </Field>
        <Field label="Removal shipment">
          <input
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.removal_shipment_id}
            onChange={(e) => patch({ removal_shipment_id: e.target.value })}
          />
        </Field>
        <Field label="Tracking number">
          <input
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.tracking_number}
            onChange={(e) => patch({ tracking_number: e.target.value })}
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
        <Field label="Min estimated payout">
          <input
            type="number"
            min={0}
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.min_estimated_payout}
            onChange={(e) => patch({ min_estimated_payout: e.target.value })}
          />
        </Field>
        <Field label="Min observed reimbursement">
          <input
            type="number"
            min={0}
            className={CLAIM_CENTER_INPUT_CLASS}
            value={filters.min_observed_reimbursement}
            onChange={(e) => patch({ min_observed_reimbursement: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-4 text-xs">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.include_needs_review}
            onChange={(e) => patch({ include_needs_review: e.target.checked })}
          />
          Include needs review
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.include_unavailable}
            onChange={(e) => patch({ include_unavailable: e.target.checked })}
          />
          Include unavailable
        </label>
      </div>
    </section>
  );
}
