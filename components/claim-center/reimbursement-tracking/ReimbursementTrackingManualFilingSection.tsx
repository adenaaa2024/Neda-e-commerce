"use client";

import { useState } from "react";
import { HandHelping } from "lucide-react";

import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  MANUAL_FILING_BUTTON_TOOLTIP,
  MANUAL_FILING_UI_COPY,
  assessManualFilingRecordEligibility,
} from "@/lib/claims/submission/claim-manual-filing-status-entry-ui-contract";
import { CLAIM_CENTER_DISABLED_BTN } from "@/components/claim-center/claim-center-ui";

import { ReimbursementTrackingManualFilingModal } from "./ReimbursementTrackingManualFilingModal";

type Props = {
  row: ReimbursementTrackingPreviewRow;
  fetchJson: <T>(path: string, extra?: Record<string, string>, init?: RequestInit) => Promise<T>;
};

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
      <span className="opacity-60">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export function ReimbursementTrackingManualFilingSection({ row, fetchJson }: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const eligibility = assessManualFilingRecordEligibility(row);
  const card = eligibility.status_card;

  return (
    <section data-manual-filing-status-entry="v1">
      <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Next action</h3>
      <div className="space-y-3 rounded-lg border bg-black/[0.03] p-3 dark:bg-white/[0.03]">
        <StatusRow label="Current status" value={card.current_status} />
        <StatusRow label="External Amazon Case ID" value={card.external_amazon_case_id} />
        <StatusRow label="Filing status" value={card.filing_status.replace(/_/g, " ")} />
        <p className="border-t border-black/5 pt-2 text-sm font-medium dark:border-white/10">{card.next_action}</p>
      </div>

      <div className="mt-3">
        {eligibility.button_enabled ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            title={MANUAL_FILING_BUTTON_TOOLTIP}
            className="claim-center-btn claim-center-btn--primary inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold"
          >
            <HandHelping className="h-3.5 w-3.5" aria-hidden />
            {MANUAL_FILING_UI_COPY.action_label}
          </button>
        ) : (
          <button
            type="button"
            disabled
            title={eligibility.disabled_reason ?? MANUAL_FILING_BUTTON_TOOLTIP}
            className={`${CLAIM_CENTER_DISABLED_BTN} inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold`}
          >
            <HandHelping className="h-3.5 w-3.5" aria-hidden />
            {MANUAL_FILING_UI_COPY.action_label}
          </button>
        )}
        <p className="mt-2 text-[11px] opacity-60">{MANUAL_FILING_UI_COPY.plan_safety_banner}</p>
        {eligibility.disabled_reason && !eligibility.button_enabled ? (
          <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-200">{eligibility.disabled_reason}</p>
        ) : null}
      </div>

      <ReimbursementTrackingManualFilingModal
        open={modalOpen}
        row={row}
        onClose={() => setModalOpen(false)}
        fetchJson={fetchJson}
      />
    </section>
  );
}
