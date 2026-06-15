"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Layers3, Loader2, Sparkles } from "lucide-react";

import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterSectionEmptyState } from "@/components/claim-center/ClaimCenterSectionEmptyState";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import type { FirstSafeFamiliesPreviewGeneratorsPayload } from "@/lib/claims/center/claim-first-safe-families-preview-generators-v1";
import { buildQueueClearState } from "@/lib/claims/center/claim-center-ui-copy";
import {
  DEFAULT_PREVIEW_GENERATORS_FILTER_STATE,
  buildGroupBuilderHref,
  filterPreviewGeneratorItems,
  previewGeneratorsApiParams,
  summarizeFilteredPreviews,
  type ClaimPreviewGeneratorsFilterState,
} from "@/lib/claims/preview/claim-preview-generators-ui-contract";

import { ClaimPreviewGeneratorsDisabledActions } from "./ClaimPreviewGeneratorsDisabledActions";
import { ClaimPreviewGeneratorsFilters } from "./ClaimPreviewGeneratorsFilters";
import { ClaimPreviewGeneratorsSummary } from "./ClaimPreviewGeneratorsSummary";
import { ClaimPreviewGeneratorsTable } from "./ClaimPreviewGeneratorsTable";

const PAGE_CONTRACT = {
  id: "pool" as const,
  route: "/claim-center/preview-generators",
  navLabel: "Preview generators",
  question: "What raw claim opportunities did generators produce?",
  dataSource: "GET /api/claims/center/preview-generators — read-only preview list",
  appearsHere:
    "Un-grouped preview rows with family, money lanes, date gates, and review flags before grouping or emit.",
  whatToDoNext:
    "Filter claim-ready rows, then open Group builder to explore batching. Emit stays disabled until operator-approved bridge.",
  whyEmpty: "Generators have not produced previews for this store, or filters exclude all rows.",
  helper: "Read-only — no claim_candidates writes, no claim_cases, no emit.",
};

const EMPTY_CONFIG = buildQueueClearState("preview_generators_ui", {
  title: "No previews match these filters",
  appearsHere: "Raw generator output before grouping or emit.",
  whyEmpty: "Try resetting filters or confirm generators ran in Sources.",
  nextSteps: [
    "Open Sources to verify generator health for this store.",
    "Reset filters to show all families.",
    "Use Group builder for batched claim-ready views.",
  ],
});

export function ClaimPreviewGeneratorsView() {
  const { fetchJson, storeId } = useClaimCenter();
  const [filters, setFilters] = useState<ClaimPreviewGeneratorsFilterState>(
    DEFAULT_PREVIEW_GENERATORS_FILTER_STATE,
  );
  const [appliedFilters, setAppliedFilters] = useState<ClaimPreviewGeneratorsFilterState>(
    DEFAULT_PREVIEW_GENERATORS_FILTER_STATE,
  );
  const [payload, setPayload] = useState<FirstSafeFamiliesPreviewGeneratorsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const loadPreviews = useCallback(async () => {
    if (!storeId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = previewGeneratorsApiParams(appliedFilters);
      const data = await fetchJson<FirstSafeFamiliesPreviewGeneratorsPayload>(
        "/api/claims/center/preview-generators",
        params,
      );
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load preview generators.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId, appliedFilters.date_from, appliedFilters.date_to]);

  useEffect(() => {
    void loadPreviews();
  }, [loadPreviews]);

  const applyFilters = () => {
    setAppliedFilters(filters);
    setSelectedIds(new Set());
  };

  const toggleSelect = (previewId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(previewId)) next.delete(previewId);
      else next.add(previewId);
      return next;
    });
  };

  const filteredRows = useMemo(() => {
    const items = payload?.previews ?? [];
    return filterPreviewGeneratorItems(items, appliedFilters);
  }, [payload?.previews, appliedFilters]);

  const summary = useMemo(() => summarizeFilteredPreviews(filteredRows), [filteredRows]);

  const groupBuilderHref = buildGroupBuilderHref([...selectedIds]);

  return (
    <ClaimCenterV2PageShell contract={PAGE_CONTRACT}>
      <div className="claim-center-card mb-4 rounded-xl border border-sky-500/25 bg-sky-500/10 px-4 py-3 text-xs">
        <p className="font-semibold text-sky-900 dark:text-sky-100">Read-only preview generators</p>
        <p className="mt-1 opacity-90">
          Wired to <code className="text-[10px]">GET /api/claims/center/preview-generators</code>. Raw
          opportunities before grouping or emit — no writes.
        </p>
      </div>

      <ClaimCenterBridgePhaseNotice />

      <ClaimPreviewGeneratorsFilters
        filters={filters}
        onChange={setFilters}
        onApply={applyFilters}
        loading={loading}
      />

      {!storeId ? (
        <ClaimCenterSectionEmptyState
          config={buildQueueClearState("preview_generators_no_store", {
            title: "Select a store",
            whyEmpty: "Preview generators are store-scoped.",
            nextSteps: ["Choose a store in the scope bar above."],
          })}
        />
      ) : loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading preview generators…
        </div>
      ) : error ? (
        <div className="claim-center-card flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-800 dark:text-red-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Could not load preview generators</p>
            <p className="mt-1 opacity-90">{error}</p>
          </div>
        </div>
      ) : (
        <>
          <ClaimPreviewGeneratorsSummary
            summary={summary}
            apiTotal={payload?.family_counts?.total_previews ?? undefined}
            loadedCount={payload?.previews?.length ?? undefined}
          />

          <section className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 opacity-60" />
              Preview list
              <span className="text-xs font-normal opacity-60">
                ({filteredRows.length} row{filteredRows.length === 1 ? "" : "s"})
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={groupBuilderHref}
                className={`claim-center-btn inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ${
                  selectedIds.size === 0 ? "pointer-events-none opacity-50" : ""
                }`}
                aria-disabled={selectedIds.size === 0}
                tabIndex={selectedIds.size === 0 ? -1 : 0}
              >
                <Layers3 className="h-3.5 w-3.5" />
                Group selected previews ({selectedIds.size})
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/claim-center/group-builder"
                className="rounded-lg border px-3 py-2 text-xs font-medium"
              >
                Open group builder
              </Link>
            </div>
          </section>

          {filteredRows.length === 0 ? (
            <ClaimCenterSectionEmptyState config={EMPTY_CONFIG} />
          ) : (
            <ClaimPreviewGeneratorsTable
              rows={filteredRows}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
            />
          )}

          {payload?.read_only && payload?.no_db_writes ? (
            <p className="text-center text-xs text-emerald-700 dark:text-emerald-300">
              API read-only · no claim_candidates mutation
            </p>
          ) : null}
        </>
      )}

      <ClaimPreviewGeneratorsDisabledActions />
    </ClaimCenterV2PageShell>
  );
}
