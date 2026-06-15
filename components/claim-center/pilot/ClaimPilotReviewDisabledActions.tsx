"use client";

import { Lock } from "lucide-react";

import { CLAIM_CENTER_DISABLED_BTN } from "@/components/claim-center/claim-center-ui";
import { PILOT_REVIEW_DISABLED_ACTIONS } from "@/lib/claims/pilot/claim-pilot-review-ui-contract";

/**
 * Read-only pilot review — approve/reject/case/submit disabled.
 * data-claim-center-write="disabled-placeholder-only" exempts smoke write checks.
 */
export function ClaimPilotReviewDisabledActions() {
  return (
    <div
      className="claim-center-card flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-4"
      data-claim-center-write="disabled-placeholder-only"
    >
      <p className="w-full text-xs opacity-70">
        Pilot review only — inspect emitted candidates before evidence packets or case creation. No writes.
      </p>
      {PILOT_REVIEW_DISABLED_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled
          aria-disabled="true"
          title="Write actions unlock after operator-approved bridge"
          className={`${CLAIM_CENTER_DISABLED_BTN} inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold`}
        >
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {action.label}
        </button>
      ))}
    </div>
  );
}
