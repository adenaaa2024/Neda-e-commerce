"use client";

import { Lock } from "lucide-react";

import { CLAIM_CENTER_DISABLED_BTN } from "@/components/claim-center/claim-center-ui";
import { CLAIM_GROUP_BUILDER_DISABLED_ACTIONS } from "@/lib/claims/grouping/claim-grouping-ui-contract";

/**
 * Read-only phase placeholders — filing bridge not wired.
 * data-claim-center-write="disabled-placeholder-only" exempts this file from write-action smoke.
 */
export function ClaimGroupBuilderDisabledActions() {
  return (
    <div
      className="claim-center-card flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-4"
      data-claim-center-write="disabled-placeholder-only"
    >
      <p className="w-full text-xs opacity-70">
        Filing actions unlock after the bridge phase. Preview grouping only — no saves or case creation.
      </p>
      {CLAIM_GROUP_BUILDER_DISABLED_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled
          aria-disabled="true"
          title="Available after filing bridge phase"
          className={`${CLAIM_CENTER_DISABLED_BTN} inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold`}
        >
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {action.label}
        </button>
      ))}
    </div>
  );
}
