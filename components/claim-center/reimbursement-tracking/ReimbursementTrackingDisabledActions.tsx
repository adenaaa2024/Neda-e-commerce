"use client";

import { Lock } from "lucide-react";

import { CLAIM_CENTER_DISABLED_BTN } from "@/components/claim-center/claim-center-ui";
import {
  REIMBURSEMENT_TRACKING_DISABLED_ACTIONS,
  REIMBURSEMENT_TRACKING_READ_ONLY_TOOLTIP,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";

export function ReimbursementTrackingDisabledActions() {
  return (
    <div
      className="claim-center-card flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-4"
      data-claim-center-write="disabled-placeholder-only"
    >
      <p className="w-full text-xs opacity-70">
        Financial tracking preview — inspect submission status and reimbursement matches. No writes.
      </p>
      {REIMBURSEMENT_TRACKING_DISABLED_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled
          aria-disabled="true"
          title={REIMBURSEMENT_TRACKING_READ_ONLY_TOOLTIP}
          className={`${CLAIM_CENTER_DISABLED_BTN} inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold`}
        >
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {action.label}
        </button>
      ))}
    </div>
  );
}
