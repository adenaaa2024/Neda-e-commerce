"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import { CLAIM_CENTER_SECTION_EMPTY } from "@/lib/claims/center/claim-center-ui-copy";

import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterMobileCards } from "@/components/claim-center/ClaimCenterMobileCards";
import { ClaimCenterQueueToolbar } from "@/components/claim-center/ClaimCenterQueueToolbar";
import { ClaimCenterSectionEmptyState } from "@/components/claim-center/ClaimCenterSectionEmptyState";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import { EvidencePacketPreviewPane } from "@/components/claim-center/EvidencePacketPreviewPane";

export default function ClaimCenterEvidencePage() {
  const contract = getClaimCenterV2Page("evidence");
  const { fetchJson, organizationId, setSelectedRow, storeId } = useClaimCenter();
  const [rows, setRows] = useState<ClaimCenterV1Row[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchJson<{ items: ClaimCenterV1Row[]; meta?: unknown; queue_note?: string }>(
      "/api/claims/center/evidence",
    );
    setRows(data.items ?? []);
    setLoading(false);
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.sku, r.fnsku, r.asin, r.claim_reason, r.v1_status_label].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [rows, search]);

  return (
    <ClaimCenterV2PageShell contract={contract}>
      <ClaimCenterQueueToolbar
        search={search}
        onSearchChange={setSearch}
        viewMode="card"
        onViewModeChange={() => {}}
        resultCount={filtered.length}
      />
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <ClaimCenterSectionEmptyState config={CLAIM_CENTER_SECTION_EMPTY.evidence} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_minmax(280px,400px)]">
          <ClaimCenterMobileCards
            rows={filtered}
            onSelect={(r) => {
              setSelectedRow(r);
              setPreviewId(r.id);
            }}
          />
          <div className="claim-center-card rounded-xl p-4 lg:sticky lg:top-4 lg:self-start">
            {previewId ? (
              <EvidencePacketPreviewPane organizationId={organizationId} candidateId={previewId} />
            ) : (
              <p className="text-sm opacity-60">Select a row to view an HTML evidence preview (read-only).</p>
            )}
          </div>
        </div>
      )}
      <div className="mt-4">
        <ClaimCenterBridgePhaseNotice compact />
      </div>
    </ClaimCenterV2PageShell>
  );
}
