"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import type { MenorixModuleViewMode } from "@/components/menorix";

import type { ClaimCenterQueryMeta, ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import { CLAIM_CENTER_SECTION_EMPTY } from "@/lib/claims/center/claim-center-ui-copy";
import { resolveSectionEmptyState } from "@/lib/claims/center/claim-center-ui-copy";

import { ClaimCenterBridgePhaseNotice } from "./ClaimCenterBridgePhaseNotice";
import { ClaimCenterDataReadinessBanner } from "./ClaimCenterDataReadinessBanner";
import { ClaimCenterHiddenRowsNotice } from "./ClaimCenterHiddenRowsNotice";
import { ClaimCenterMobileCards } from "./ClaimCenterMobileCards";
import { ClaimCenterQueueToolbar } from "./ClaimCenterQueueToolbar";
import { ClaimCenterSampleWarningBanner } from "./ClaimCenterSampleWarningBanner";
import { ClaimCenterSectionEmptyState } from "./ClaimCenterSectionEmptyState";
import { ClaimCenterV2PageShell } from "./ClaimCenterV2PageShell";
import { useClaimCenter } from "./ClaimCenterRootClient";
import { SeparateFamilyOpportunitiesPanel } from "./opportunities/SeparateFamilyOpportunitiesPanel";

type Payload = {
  items: ClaimCenterV1Row[];
  blocked_money_items?: ClaimCenterV1Row[];
  queue_note?: string;
  meta?: ClaimCenterQueryMeta;
};

export function ClaimCenterOpportunitiesView() {
  const contract = getClaimCenterV2Page("opportunities");
  const { fetchJson, setSelectedRow, storeId } = useClaimCenter();
  const [items, setItems] = useState<ClaimCenterV1Row[]>([]);
  const [blockedCount, setBlockedCount] = useState(0);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [meta, setMeta] = useState<ClaimCenterQueryMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<MenorixModuleViewMode>("card");

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchJson<Payload>("/api/claims/center/opportunities", { limit: "100" });
    setItems(data.items ?? []);
    setBlockedCount((data.blocked_money_items ?? []).length);
    setQueueNote(data.queue_note ?? null);
    setMeta(data.meta ?? null);
    setLoading(false);
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  const filterFn = (r: ClaimCenterV1Row) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.sku, r.fnsku, r.claim_family, r.v1_status_label].filter(Boolean).join(" ").toLowerCase().includes(q);
  };

  const filtered = useMemo(() => items.filter(filterFn), [items, search]);

  const poolEmpty =
    (meta?.db_total_count != null && meta.db_total_count === 0) ||
    (meta?.db_total_count == null && items.length === 0 && !loading);

  const resolvedEmpty = resolveSectionEmptyState(CLAIM_CENTER_SECTION_EMPTY.opportunities, { poolEmpty });

  return (
    <ClaimCenterV2PageShell
      contract={contract}
      banner={<ClaimCenterHiddenRowsNotice />}
      dataBanner={poolEmpty && !loading ? <ClaimCenterDataReadinessBanner meta={meta} /> : undefined}
    >
      {queueNote ? (
        <p className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed opacity-80">
          {queueNote}
        </p>
      ) : null}
      <ClaimCenterSampleWarningBanner meta={meta} />
      {blockedCount > 0 ? (
        <p className="mb-3 text-xs text-amber-800 dark:text-amber-200">
          {blockedCount} grouped {blockedCount === 1 ? "row has" : "rows have"} product or reference blockers — still
          listed here as recoverable money.
        </p>
      ) : null}
      <ClaimCenterQueueToolbar
        search={search}
        onSearchChange={setSearch}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        resultCount={filtered.length}
      />
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <ClaimCenterSectionEmptyState config={resolvedEmpty} />
      ) : (
        <ClaimCenterMobileCards rows={filtered} onSelect={setSelectedRow} />
      )}
      <div className="mt-6 border-t pt-6">
        <SeparateFamilyOpportunitiesPanel variant="opportunities" />
      </div>
      <div className="mt-4">
        <ClaimCenterBridgePhaseNotice compact />
      </div>
    </ClaimCenterV2PageShell>
  );
}
