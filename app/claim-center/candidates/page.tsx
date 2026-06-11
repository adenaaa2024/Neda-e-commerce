"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterListTable } from "@/components/claim-center/ClaimCenterListTable";
import { ClaimCenterMobileCards } from "@/components/claim-center/ClaimCenterMobileCards";
import { ClaimCenterPageShell } from "@/components/claim-center/ClaimCenterPageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

export default function ClaimCenterCandidatesPage() {
  const { organizationId, storeId, setSelectedRow } = useClaimCenter();
  const [rows, setRows] = useState<ClaimCenterV1Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLegacy, setShowLegacy] = useState(false);
  const [showQuarantined, setShowQuarantined] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams({
      organization_id: organizationId,
      view: "center_v1",
      limit: "100",
      include_legacy_seed: showLegacy ? "1" : "0",
      include_quarantined: showQuarantined ? "1" : "0",
    });
    if (storeId) p.set("store_id", storeId);
    const res = await fetch(`/api/claims/inbox?${p}`);
    const data = await res.json();
    setRows((data.items ?? []) as ClaimCenterV1Row[]);
    setLoading(false);
  }, [organizationId, storeId, showLegacy, showQuarantined]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ClaimCenterPageShell
      title="Candidates"
      description="Full claim opportunity pool from scheduled scans and live triggers. Legacy and quarantined rows are hidden by default."
    >
      <div className="mb-4 flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={showLegacy} onChange={(e) => setShowLegacy(e.target.checked)} />
          Show legacy sources
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={showQuarantined} onChange={(e) => setShowQuarantined(e.target.checked)} />
          Show quarantined
        </label>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading candidates…
        </div>
      ) : (
        <>
          <ClaimCenterListTable rows={rows} onSelect={setSelectedRow} />
          <div className="md:hidden">
            <ClaimCenterMobileCards rows={rows} onSelect={setSelectedRow} />
          </div>
        </>
      )}
    </ClaimCenterPageShell>
  );
}
