"use client";

import { Info } from "lucide-react";

import { CLAIM_CENTER_LEGACY_HIDDEN_COPY } from "@/lib/claims/center/claim-center-ui-copy";

/** Visible on Candidates / Opportunities — no toggle pretense. */
export function ClaimCenterHiddenRowsNotice() {
  return (
    <div className="claim-center-banner mb-4 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-snug opacity-90">
      <Info className="mt-0.5 h-4 w-4 shrink-0 opacity-70" aria-hidden />
      <p>{CLAIM_CENTER_LEGACY_HIDDEN_COPY}</p>
    </div>
  );
}
