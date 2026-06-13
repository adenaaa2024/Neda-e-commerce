"use client";

import { Lock } from "lucide-react";

import { CLAIM_CENTER_BRIDGE_PHASE_COPY } from "@/lib/claims/center/claim-center-ui-copy";

export function ClaimCenterBridgePhaseNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border border-slate-500/25 bg-slate-500/10 text-xs leading-snug ${
        compact ? "px-3 py-2" : "px-4 py-3"
      }`}
      role="note"
    >
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
      <p className="opacity-85">{CLAIM_CENTER_BRIDGE_PHASE_COPY}</p>
    </div>
  );
}
