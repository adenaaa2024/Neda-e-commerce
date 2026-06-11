"use client";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

export function OrbitFraCarryForwardBanner({ row }: { row: ClaimCenterV1Row }) {
  const external = row.orbit_external_case_status;
  return (
    <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">
      <p className="font-semibold">ORBIT-FRA import</p>
      <p className="mt-1 text-xs opacity-80">
        This opportunity was imported from an external ORBIT spreadsheet. Case status is tracked externally only.
      </p>
      {external ? (
        <p className="mt-2 text-xs">
          <span className="font-medium">External status:</span> {external}
          {row.orbit_case_group ? ` · Group: ${row.orbit_case_group}` : ""}
        </p>
      ) : null}
      {row.source_observed_window ? (
        <p className="mt-1 text-xs opacity-70">
          Observed filing window from source: {row.source_observed_window.status}
          {row.source_observed_window.deadline ? ` · ${row.source_observed_window.deadline}` : ""}
        </p>
      ) : null}
    </div>
  );
}
