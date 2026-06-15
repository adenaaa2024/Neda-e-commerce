"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowRight, Layers3, Loader2, Package } from "lucide-react";

import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterSectionEmptyState } from "@/components/claim-center/ClaimCenterSectionEmptyState";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import { CLAIM_CENTER_SELECT_CLASS } from "@/components/claim-center/claim-center-ui";
import type { ClaimGroupingReadmodelPayload } from "@/lib/claims/grouping/claim-grouping-readmodel";
import type { GroupingModeSupported } from "@/lib/claims/grouping/claim-grouping-readmodel";
import {
  DEFAULT_GROUP_BUILDER_FILTER_STATE,
  GROUPING_MODE_UI_LABELS,
  GROUPING_MODES_UI,
  activeFilterChipCount,
  filterStateToApiParams,
  type ClaimGroupBuilderFilterState,
} from "@/lib/claims/grouping/claim-grouping-ui-contract";
import { buildQueueClearState } from "@/lib/claims/center/claim-center-ui-copy";

import { ClaimGroupBuilderDisabledActions } from "./ClaimGroupBuilderDisabledActions";
import { ClaimGroupBuilderFilters } from "./ClaimGroupBuilderFilters";
import { ClaimGroupManualSelection } from "./ClaimGroupManualSelection";
import { ClaimGroupPreviewCard } from "./ClaimGroupPreviewCard";

const PAGE_CONTRACT = {
  id: "pool" as const,
  route: "/claim-center/group-builder",
  navLabel: "Group builder",
  question: "How should claim-ready previews be grouped before case creation?",
  dataSource: "GET /api/claims/center/grouping-preview — preview generators only",
  appearsHere: "Read-only group previews with filters, warnings, and manual selection.",
  whatToDoNext: "Review warnings per group. Filing and emit actions unlock after the bridge phase.",
  whyEmpty: "No previews match your filters, or generators have not produced rows for this store.",
  helper: "Preview-only — no claim_candidates writes, no claim_cases.",
};

const EMPTY_CONFIG = buildQueueClearState("group_builder_ui", {
  title: "No groups match these filters",
  appearsHere: "Grouped preview cards for claim-ready and review lanes.",
  whyEmpty: "Try broader filters, include needs review, or confirm generators ran in Sources.",
  nextSteps: [
    "Open Sources to verify preview generators ran for this store.",
    "Reset filters to the claim-ready default.",
    "Use Legacy tools → Returns draft pool for physical-return grouping only.",
  ],
});

export function ClaimGroupBuilderView() {
  const { fetchJson, storeId } = useClaimCenter();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<ClaimGroupBuilderFilterState>(DEFAULT_GROUP_BUILDER_FILTER_STATE);
  const [appliedFilters, setAppliedFilters] = useState<ClaimGroupBuilderFilterState>(DEFAULT_GROUP_BUILDER_FILTER_STATE);
  const [groupingMode, setGroupingMode] = useState<GroupingModeSupported>("product_family");
  const [payload, setPayload] = useState<ClaimGroupingReadmodelPayload | null>(null);
  const [rowPayload, setRowPayload] = useState<ClaimGroupingReadmodelPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPreviewIds, setSelectedPreviewIds] = useState<Set<string>>(new Set());
  const [manualPreview, setManualPreview] = useState<ClaimGroupingReadmodelPayload["groups"][0] | null>(null);
  const [manualLoading, setManualLoading] = useState(false);

  const loadGroups = useCallback(
    async (mode: GroupingModeSupported, f: ClaimGroupBuilderFilterState) => {
      if (!storeId) {
        setPayload(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const params = filterStateToApiParams(f, mode, { limit: 50 });
        const data = await fetchJson<ClaimGroupingReadmodelPayload>("/api/claims/center/grouping-preview", params);
        setPayload(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load grouping preview.");
        setPayload(null);
      } finally {
        setLoading(false);
      }
    },
    [fetchJson, storeId],
  );

  const loadSelectableRows = useCallback(
    async (f: ClaimGroupBuilderFilterState) => {
      if (!storeId) {
        setRowPayload(null);
        return;
      }
      try {
        const params = filterStateToApiParams(f, "one_candidate_per_group", { limit: 100 });
        const data = await fetchJson<ClaimGroupingReadmodelPayload>("/api/claims/center/grouping-preview", params);
        setRowPayload(data);
      } catch {
        setRowPayload(null);
      }
    },
    [fetchJson, storeId],
  );

  useEffect(() => {
    const raw = searchParams.get("preview_ids");
    if (!raw) return;
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return;
    setSelectedPreviewIds(new Set(ids));
    const mode = searchParams.get("grouping_mode");
    if (mode && GROUPING_MODES_UI.includes(mode as GroupingModeSupported)) {
      setGroupingMode(mode as GroupingModeSupported);
    }
    if (searchParams.get("include_needs_review") === "true") {
      const withReview = { ...DEFAULT_GROUP_BUILDER_FILTER_STATE, include_needs_review: true };
      setFilters(withReview);
      setAppliedFilters(withReview);
    }
  }, [searchParams]);

  useEffect(() => {
    void loadGroups(groupingMode, appliedFilters);
    void loadSelectableRows(appliedFilters);
  }, [loadGroups, loadSelectableRows, groupingMode, appliedFilters, storeId]);

  const applyFilters = () => {
    setAppliedFilters(filters);
    setSelectedPreviewIds(new Set());
    setManualPreview(null);
  };

  const onModeChange = (mode: GroupingModeSupported) => {
    setGroupingMode(mode);
    setManualPreview(null);
  };

  const togglePreviewId = (previewId: string) => {
    setSelectedPreviewIds((prev) => {
      const next = new Set(prev);
      if (next.has(previewId)) next.delete(previewId);
      else next.add(previewId);
      return next;
    });
    setManualPreview(null);
  };

  const previewManualGroup = async () => {
    if (!storeId || selectedPreviewIds.size === 0) return;
    setManualLoading(true);
    try {
      const params = filterStateToApiParams(appliedFilters, "manual_selection_preview", {
        preview_ids: [...selectedPreviewIds],
        limit: 5,
      });
      const data = await fetchJson<ClaimGroupingReadmodelPayload>("/api/claims/center/grouping-preview", params);
      setManualPreview(data.groups[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Manual preview failed.");
    } finally {
      setManualLoading(false);
    }
  };

  const groups = payload?.groups ?? [];
  const claimReadyGroups = useMemo(
    () => groups.filter((g) => g.recommended_action === "file_single" || g.recommended_action === "file_grouped"),
    [groups],
  );
  const needsReviewGroups = useMemo(
    () => groups.filter((g) => g.recommended_action === "needs_review" || g.recommended_action === "split_group"),
    [groups],
  );

  const showNeedsReviewBanner = appliedFilters.include_needs_review || appliedFilters.status === "needs_review";

  return (
    <ClaimCenterV2PageShell contract={PAGE_CONTRACT}>
      <div className="claim-center-card mb-4 rounded-xl border border-sky-500/25 bg-sky-500/10 px-4 py-3 text-xs">
        <p className="font-semibold text-sky-900 dark:text-sky-100">Read-only group builder</p>
        <p className="mt-1 opacity-90">
          Previews only — wired to <code className="text-[10px]">grouping-preview</code>. No claim_candidates writes,
          no claim_cases, no emit.
        </p>
      </div>

      <div className="claim-center-card mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs">
        <p className="font-semibold text-amber-900 dark:text-amber-100">Legacy physical-return grouping</p>
        <p className="mt-1 opacity-90">
          Event-based physical returns still use{" "}
          <Link href="/returns/claims" className="font-semibold underline">
            Returns draft pool
          </Link>
          .
        </p>
      </div>

      <ClaimGroupBuilderFilters
        filters={filters}
        onChange={setFilters}
        onApply={applyFilters}
        loading={loading}
      />

      <section className="claim-center-card flex flex-wrap items-end justify-between gap-3 rounded-xl p-4">
        <label className="block min-w-[220px] flex-1 space-y-1 text-xs">
          <span className="font-semibold opacity-70">Grouping mode</span>
          <select
            className={`${CLAIM_CENTER_SELECT_CLASS} w-full`}
            value={groupingMode}
            onChange={(e) => onModeChange(e.target.value as GroupingModeSupported)}
          >
            {GROUPING_MODES_UI.map((mode) => (
              <option key={mode} value={mode}>
                {GROUPING_MODE_UI_LABELS[mode].label}
              </option>
            ))}
          </select>
          <span className="block opacity-60">{GROUPING_MODE_UI_LABELS[groupingMode].description}</span>
        </label>

        <div className="text-right text-xs opacity-75">
          <p>
            <span className="font-semibold tabular-nums">{payload?.filtered_preview_count ?? "—"}</span> previews
            filtered
          </p>
          <p>
            <span className="font-semibold tabular-nums">{payload?.group_count ?? "—"}</span> groups ·{" "}
            {activeFilterChipCount(appliedFilters)} active filter
            {activeFilterChipCount(appliedFilters) === 1 ? "" : "s"}
          </p>
          {payload?.read_only ? (
            <p className="text-emerald-700 dark:text-emerald-300">API read-only ✓</p>
          ) : null}
        </div>
      </section>

      {!storeId ? (
        <ClaimCenterSectionEmptyState
          config={buildQueueClearState("group_builder_no_store", {
            title: "Select a store",
            whyEmpty: "Group previews are store-scoped.",
            nextSteps: ["Choose a store in the scope bar above."],
          })}
        />
      ) : loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading group previews…
        </div>
      ) : error ? (
        <div className="claim-center-card flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-800 dark:text-red-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Could not load grouping preview</p>
            <p className="mt-1 text-xs opacity-90">{error}</p>
          </div>
        </div>
      ) : groups.length === 0 ? (
        <ClaimCenterSectionEmptyState config={EMPTY_CONFIG} />
      ) : (
        <>
          {showNeedsReviewBanner && needsReviewGroups.length ? (
            <p className="text-xs text-amber-800 dark:text-amber-200">
              Showing {needsReviewGroups.length} group(s) with needs-review or split recommendations.
            </p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => (
              <ClaimGroupPreviewCard key={g.group_preview_id} group={g} />
            ))}
          </div>

          <div className="grid gap-3 text-xs opacity-70 sm:grid-cols-3">
            <p>
              Claim-ready style groups: <strong>{claimReadyGroups.length}</strong>
            </p>
            <p>
              Review / split groups: <strong>{needsReviewGroups.length}</strong>
            </p>
            <p>
              Sample IDs in payload: <strong>{payload?.sample_group_previews?.length ?? 0}</strong>
            </p>
          </div>
        </>
      )}

      <ClaimGroupManualSelection
        rowGroups={rowPayload?.groups ?? []}
        selectedPreviewIds={selectedPreviewIds}
        onTogglePreviewId={togglePreviewId}
        onClearSelection={() => {
          setSelectedPreviewIds(new Set());
          setManualPreview(null);
        }}
        onPreviewManualGroup={() => void previewManualGroup()}
        manualPreview={manualPreview}
        manualLoading={manualLoading}
      />

      <ClaimGroupBuilderDisabledActions />

      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/returns/claims"
          className="claim-center-card flex items-center gap-3 rounded-xl p-4 transition-shadow hover:shadow-md"
        >
          <Package className="h-5 w-5 opacity-60" />
          <div className="flex-1">
            <p className="font-medium">Returns draft pool</p>
            <p className="text-xs opacity-65">Legacy physical-return grouping</p>
          </div>
          <ArrowRight className="h-4 w-4 opacity-50" />
        </Link>
        <div className="claim-center-card flex items-start gap-3 rounded-xl p-4">
          <Layers3 className="h-5 w-5 opacity-60" />
          <div>
            <p className="font-medium">Native grouping (this page)</p>
            <p className="text-xs opacity-65">Preview generators · read-only V1</p>
          </div>
        </div>
      </div>

      <ClaimCenterBridgePhaseNotice compact />
    </ClaimCenterV2PageShell>
  );
}
