"use client";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

const EVIDENCE_HINTS: Record<string, string> = {
  complete: "All required evidence artifacts are present for review.",
  partial: "Some evidence is present; additional artifacts may be required before filing.",
  missing: "Required evidence is not yet attached to this opportunity.",
};

export function EvidenceChecklistPanel({ row }: { row: ClaimCenterV1Row }) {
  const status = row.evidence_status ?? "unknown";
  return (
    <section className="claim-center-card mb-4 rounded-xl p-3">
      <h3 className="text-sm font-semibold">Evidence checklist</h3>
      <p className="mt-1 text-xs capitalize opacity-80">{status.replace(/_/g, " ")}</p>
      <p className="mt-2 text-xs opacity-70">{EVIDENCE_HINTS[status] ?? "Evidence status unknown."}</p>
      {row.orbit_evidence_summary ? (
        <p className="mt-2 text-xs">
          <span className="font-medium">ORBIT summary:</span> {row.orbit_evidence_summary}
        </p>
      ) : null}
    </section>
  );
}
