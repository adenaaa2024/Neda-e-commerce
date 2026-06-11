"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterListTable } from "@/components/claim-center/ClaimCenterListTable";
import { ClaimCenterMobileCards } from "@/components/claim-center/ClaimCenterMobileCards";
import { ClaimCenterPageShell } from "@/components/claim-center/ClaimCenterPageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import { EvidencePacketPreviewPane } from "@/components/claim-center/EvidencePacketPreviewPane";
import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

export default function ClaimCenterEvidencePage() {
  const { fetchJson, organizationId, setSelectedRow, storeId } = useClaimCenter();
  const [rows, setRows] = useState<ClaimCenterV1Row[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchJson<{ items: ClaimCenterV1Row[] }>("/api/claims/center/review");
    const filtered = (data.items ?? []).filter(
      (r) => r.evidence_status !== "complete" || r.v1_status_group === "evidence_ready",
    );
    setRows(filtered.length ? filtered : data.items ?? []);
    setLoading(false);
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  return (
    <ClaimCenterPageShell
      title="Evidence"
      description="Evidence readiness and packet preview. Generate read-only HTML previews — no PDF or submission."
    >
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <ClaimCenterListTable
            rows={rows}
            onSelect={(r) => {
              setSelectedRow(r);
              setPreviewId(r.id);
            }}
          />
          <div className="md:hidden">
            <ClaimCenterMobileCards
              rows={rows}
              onSelect={(r) => {
                setSelectedRow(r);
                setPreviewId(r.id);
              }}
            />
          </div>
          {previewId ? (
            <div className="mt-6">
              <EvidencePacketPreviewPane organizationId={organizationId} candidateId={previewId} />
            </div>
          ) : null}
        </>
      )}
    </ClaimCenterPageShell>
  );
}
