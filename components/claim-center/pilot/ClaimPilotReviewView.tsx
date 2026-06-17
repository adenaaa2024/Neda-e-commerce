"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import type { ClaimPilotReviewPayload, ClaimPilotReviewRow } from "@/lib/claims/pilot/claim-pilot-review-readmodel";
import {
  DEFAULT_PILOT_REVIEW_FILTER_STATE,
  pilotReviewApiParams,
  summarizePilotReviewRows,
  type ClaimPilotReviewFilterState,
} from "@/lib/claims/pilot/claim-pilot-review-ui-contract";

import { ClaimPilotReviewDetailDrawer } from "./ClaimPilotReviewDetailDrawer";
import { ClaimPilotReviewDisabledActions } from "./ClaimPilotReviewDisabledActions";
import { ClaimPilotReviewBulkCasePreviewPanel } from "./ClaimPilotReviewBulkCasePreviewPanel";
import { ClaimPilotReviewFilters } from "./ClaimPilotReviewFilters";
import { ClaimPilotReviewSummaryCards } from "./ClaimPilotReviewSummary";
import { ClaimPilotReviewTable } from "./ClaimPilotReviewTable";

const PAGE_CONTRACT = {
  id: "pool" as const,
  route: "/claim-center/pilot-review",
  navLabel: "Pilot review",
  question: "Are the original emit pilot candidates trustworthy before evidence work?",
  dataSource: "GET /api/claims/center/pilot-review — read-only emitted claim_candidates",
  appearsHere:
    "Active pilot rows scoped by intake_run_id with family, date gate, edges, and evidence metadata.",
  whatToDoNext:
    "Inspect each row in the detail drawer. Approve/reject and case creation stay disabled until bridge approval.",
  whyEmpty: "Pilot rows may be quarantined, filtered out, or the intake_run_id does not match this store.",
  helper: "Read-only — no claim_candidates writes, no claim_cases, no submissions.",
};

export function ClaimPilotReviewView() {
  const { fetchJson, storeId, organizationId } = useClaimCenter();
  const [filters, setFilters] = useState<ClaimPilotReviewFilterState>(DEFAULT_PILOT_REVIEW_FILTER_STATE);
  const [appliedFilters, setAppliedFilters] = useState<ClaimPilotReviewFilterState>(
    DEFAULT_PILOT_REVIEW_FILTER_STATE,
  );
  const [payload, setPayload] = useState<ClaimPilotReviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<ClaimPilotReviewRow | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());

  const toggleCheck = (rowId: string, checked: boolean) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  };

  const loadPilotRows = useCallback(async () => {
    if (!storeId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = pilotReviewApiParams(appliedFilters);
      const data = await fetchJson<ClaimPilotReviewPayload>("/api/claims/center/pilot-review", params);
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load pilot review.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId, appliedFilters]);

  useEffect(() => {
    void loadPilotRows();
  }, [loadPilotRows]);

  const rows = payload?.rows ?? [];
  const summary = useMemo(() => payload?.summary ?? summarizePilotReviewRows(rows), [payload?.summary, rows]);

  const applyFilters = () => {
    setAppliedFilters(filters);
    setSelectedRow(null);
    setCheckedIds(new Set());
  };

  const resetFilters = () => {
    setFilters(DEFAULT_PILOT_REVIEW_FILTER_STATE);
    setAppliedFilters(DEFAULT_PILOT_REVIEW_FILTER_STATE);
    setSelectedRow(null);
    setCheckedIds(new Set());
  };

  return (
    <ClaimCenterV2PageShell contract={PAGE_CONTRACT}>
      <div className="claim-center-card mb-4 rounded-xl border border-sky-500/25 bg-sky-500/10 px-4 py-3 text-xs">
        <p className="font-semibold text-sky-900 dark:text-sky-100">Original pilot review (read-only)</p>
        <p className="mt-1 opacity-90">
          Wired to <code className="text-[10px]">GET /api/claims/center/pilot-review</code>. Inspect emitted
          candidates before evidence packets or case creation.
        </p>
      </div>

      <div className="mb-4">
        <ClaimCenterBridgePhaseNotice />
      </div>

      <ClaimPilotReviewFilters
        filters={filters}
        onChange={setFilters}
        onApply={applyFilters}
        onReset={resetFilters}
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm opacity-70">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          Loading pilot candidates…
        </div>
      ) : error ? (
        <div className="claim-center-card rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-6 text-sm">
          <p className="font-semibold text-red-800 dark:text-red-200">Could not load pilot review</p>
          <p className="mt-2 opacity-80">{error}</p>
        </div>
      ) : (
        <>
          <div className="my-6">
            <ClaimPilotReviewSummaryCards
              summary={summary}
              intakeRunId={payload?.intake_run_id ?? appliedFilters.intake_run_id}
            />
          </div>

          <ClaimPilotReviewDisabledActions />

          <div className="my-6">
            <ClaimPilotReviewBulkCasePreviewPanel
              intakeRunId={payload?.intake_run_id ?? appliedFilters.intake_run_id}
              selectedCandidateIds={[...checkedIds]}
              totalPilotCount={rows.length}
              fetchJson={fetchJson}
            />
          </div>

          <div className="mt-6">
            <ClaimPilotReviewTable
              rows={rows}
              selectedId={selectedRow?.id ?? null}
              checkedIds={checkedIds}
              onSelect={setSelectedRow}
              onToggleCheck={toggleCheck}
              emptyLabel="No pilot candidates match these filters."
            />
          </div>
        </>
      )}

      <ClaimPilotReviewDetailDrawer
        row={selectedRow}
        organizationId={organizationId}
        intakeRunId={payload?.intake_run_id ?? appliedFilters.intake_run_id}
        fetchJson={fetchJson}
        onClose={() => setSelectedRow(null)}
      />
    </ClaimCenterV2PageShell>
  );
}
