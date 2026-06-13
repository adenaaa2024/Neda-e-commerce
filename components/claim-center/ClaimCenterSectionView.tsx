"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import type { MenorixModuleViewMode } from "@/components/menorix";
import type { ClaimCenterQueryMeta, ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";
import type { ClaimCenterV2PageId } from "@/lib/claims/center/claim-center-v2-page-contract";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import type { ClaimCenterSectionEmptyConfig } from "@/lib/claims/center/claim-center-ui-copy";
import { resolveSectionEmptyState } from "@/lib/claims/center/claim-center-ui-copy";

import { ClaimCenterBridgePhaseNotice } from "./ClaimCenterBridgePhaseNotice";
import { ClaimCenterDataReadinessBanner } from "./ClaimCenterDataReadinessBanner";
import { ClaimCenterListTable } from "./ClaimCenterListTable";
import { ClaimCenterMobileCards } from "./ClaimCenterMobileCards";
import { ClaimCenterQueueToolbar } from "./ClaimCenterQueueToolbar";
import { ClaimCenterSampleWarningBanner } from "./ClaimCenterSampleWarningBanner";
import { ClaimCenterSectionEmptyState } from "./ClaimCenterSectionEmptyState";
import { ClaimCenterV2PageShell } from "./ClaimCenterV2PageShell";
import { useClaimCenter } from "./ClaimCenterRootClient";

type Props = {
  pageId: ClaimCenterV2PageId;
  apiPath: string;
  extraParams?: Record<string, string>;
  itemsKey?: string;
  banner?: React.ReactNode;
  filterContent?: React.ReactNode;
  defaultViewMode?: MenorixModuleViewMode;
  emptyState: ClaimCenterSectionEmptyConfig;
};

function matchesSearch(row: ClaimCenterV1Row, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    row.sku,
    row.fnsku,
    row.asin,
    row.claim_reason,
    row.reference_id,
    row.amazon_reference_id,
    row.v1_status_label,
    row.source_kind,
    row.claim_family,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

export function ClaimCenterSectionView({
  pageId,
  apiPath,
  extraParams,
  itemsKey = "items",
  banner,
  filterContent,
  defaultViewMode = "card",
  emptyState,
}: Props) {
  const contract = getClaimCenterV2Page(pageId);
  const { fetchJson, setSelectedRow, storeId } = useClaimCenter();
  const [rows, setRows] = useState<ClaimCenterV1Row[]>([]);
  const [meta, setMeta] = useState<ClaimCenterQueryMeta | null>(null);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [apiEmptyMessage, setApiEmptyMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<MenorixModuleViewMode>(defaultViewMode);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<Record<string, unknown>>(apiPath, { limit: "100", ...extraParams });
      const items = (data[itemsKey] ?? data.items ?? []) as ClaimCenterV1Row[];
      setRows(items);
      setMeta((data.meta as ClaimCenterQueryMeta | undefined) ?? null);
      setQueueNote(typeof data.queue_note === "string" ? data.queue_note : null);
      setApiEmptyMessage(typeof data.empty_message === "string" ? data.empty_message : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
      setRows([]);
      setMeta(null);
      setQueueNote(null);
      setApiEmptyMessage(null);
    } finally {
      setLoading(false);
    }
  }, [apiPath, extraParams, fetchJson, itemsKey]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  const filtered = useMemo(() => rows.filter((r) => matchesSearch(r, search)), [rows, search]);

  const showTableOnDesktop = viewMode === "table" || viewMode === "queue";
  const poolEmpty =
    (meta?.db_total_count != null && meta.db_total_count === 0) ||
    (meta?.db_total_count == null && rows.length === 0 && !loading && !error);

  const resolvedEmpty = resolveSectionEmptyState(emptyState, { poolEmpty });

  return (
    <ClaimCenterV2PageShell
      contract={contract}
      banner={banner}
      dataBanner={poolEmpty && !loading ? <ClaimCenterDataReadinessBanner meta={meta} /> : undefined}
    >
      {queueNote ? (
        <p className="mb-3 rounded-lg border border-black/10 px-3 py-2 text-xs leading-relaxed opacity-75 dark:border-white/10">
          {queueNote}
        </p>
      ) : null}
      <ClaimCenterSampleWarningBanner meta={meta} />
      <ClaimCenterQueueToolbar
        search={search}
        onSearchChange={setSearch}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filterContent={filterContent}
        resultCount={filtered.length}
      />
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : filtered.length === 0 ? (
        <ClaimCenterSectionEmptyState
          config={
            apiEmptyMessage
              ? { ...resolvedEmpty, title: apiEmptyMessage, whyEmpty: apiEmptyMessage }
              : resolvedEmpty
          }
        />
      ) : (
        <>
          {showTableOnDesktop ? (
            <div className="hidden lg:block">
              <ClaimCenterListTable rows={filtered} onSelect={setSelectedRow} />
            </div>
          ) : null}
          <div className={showTableOnDesktop ? "lg:hidden" : ""}>
            <ClaimCenterMobileCards
              rows={filtered}
              onSelect={setSelectedRow}
              layout={viewMode === "board" ? "board" : "list"}
            />
          </div>
        </>
      )}
      <div className="mt-4">
        <ClaimCenterBridgePhaseNotice compact />
      </div>
    </ClaimCenterV2PageShell>
  );
}
