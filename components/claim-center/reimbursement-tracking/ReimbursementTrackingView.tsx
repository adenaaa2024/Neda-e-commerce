"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterFinancialNav } from "@/components/claim-center/financial/ClaimCenterFinancialNav";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  DEFAULT_REIMBURSEMENT_TRACKING_FILTERS,
  REIMBURSEMENT_TRACKING_PAGE_CONTRACT,
  filterReimbursementTrackingRows,
  reimbursementTrackingApiParams,
  type ReimbursementTrackingFilterState,
  type ReimbursementTrackingUiPayload,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";

import { ReimbursementTrackingDetailDrawer } from "./ReimbursementTrackingDetailDrawer";
import { ReimbursementTrackingDisabledActions } from "./ReimbursementTrackingDisabledActions";
import { ReimbursementTrackingFilters } from "./ReimbursementTrackingFilters";
import { ReimbursementTrackingHeader } from "./ReimbursementTrackingHeader";
import { ReimbursementTrackingSummaryCards } from "./ReimbursementTrackingSummaryCards";
import { ReimbursementTrackingTable } from "./ReimbursementTrackingTable";
import { ReimbursementTrackingWorkflowStrip } from "./ReimbursementTrackingWorkflowStrip";

export function ReimbursementTrackingView() {
  const { fetchJson, storeId, stores } = useClaimCenter();
  const [filters, setFilters] = useState<ReimbursementTrackingFilterState>(
    DEFAULT_REIMBURSEMENT_TRACKING_FILTERS,
  );
  const [appliedFilters, setAppliedFilters] = useState<ReimbursementTrackingFilterState>(
    DEFAULT_REIMBURSEMENT_TRACKING_FILTERS,
  );
  const [payload, setPayload] = useState<ReimbursementTrackingUiPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<ReimbursementTrackingPreviewRow | null>(null);

  const storePlatform = useMemo(
    () => stores.find((s) => s.store_id === storeId)?.platform ?? null,
    [stores, storeId],
  );

  const load = useCallback(async () => {
    if (!storeId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = reimbursementTrackingApiParams(appliedFilters);
      const data = await fetchJson<ReimbursementTrackingUiPayload>(
        "/api/claims/center/reimbursement-tracking",
        params,
      );
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reimbursement tracking.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId, appliedFilters]);

  useEffect(() => {
    void load();
  }, [load]);

  const allRows = payload?.previews ?? [];
  const filteredRows = useMemo(
    () => filterReimbursementTrackingRows(allRows, appliedFilters),
    [allRows, appliedFilters],
  );

  const applyFilters = () => {
    setAppliedFilters(filters);
    setSelectedRow(null);
  };

  const resetFilters = () => {
    setFilters(DEFAULT_REIMBURSEMENT_TRACKING_FILTERS);
    setAppliedFilters(DEFAULT_REIMBURSEMENT_TRACKING_FILTERS);
    setSelectedRow(null);
  };

  const removeChip = (key: keyof ReimbursementTrackingFilterState) => {
    const cleared = { ...appliedFilters, [key]: DEFAULT_REIMBURSEMENT_TRACKING_FILTERS[key] };
    setFilters(cleared);
    setAppliedFilters(cleared);
    setSelectedRow(null);
  };

  const emptyPilot = !loading && !error && payload != null && payload.previews.length === 0;
  const noMatches = payload != null && payload.summary_cards.matched_reimbursements === 0;
  const incompleteMoney =
    payload != null &&
    payload.previews.some((p) => p.estimated_amount == null && p.recovery_value == null);

  return (
    <ClaimCenterV2PageShell contract={REIMBURSEMENT_TRACKING_PAGE_CONTRACT}>
      <ClaimCenterFinancialNav />

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading reimbursement tracking…
        </div>
      ) : error ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </p>
      ) : payload ? (
        <div className="space-y-6">
          <ReimbursementTrackingHeader payload={payload} />

          {emptyPilot ? (
            <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm opacity-70">
              No pilot submission records found. Run Claim Submission Record Pilot first.
            </p>
          ) : (
            <>
              <ReimbursementTrackingSummaryCards payload={payload} />
              <ReimbursementTrackingWorkflowStrip counts={payload.workflow_counts} />

              {noMatches ? (
                <p className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-xs opacity-80">
                  No reimbursement matched yet. This is normal before manual filing or Amazon response.
                </p>
              ) : null}

              {incompleteMoney ? (
                <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:text-amber-100">
                  Money lanes are incomplete. The system will not assume zero.
                </p>
              ) : null}

              <ReimbursementTrackingDisabledActions />

              <ReimbursementTrackingFilters
                filters={filters}
                rows={allRows}
                onChange={setFilters}
                onApply={applyFilters}
                onReset={resetFilters}
                onRemoveChip={removeChip}
              />

              <ReimbursementTrackingTable
                rows={filteredRows}
                selectedId={selectedRow?.claim_submission_id ?? null}
                onSelect={setSelectedRow}
                storePlatform={storePlatform}
              />
            </>
          )}
        </div>
      ) : null}

      <ReimbursementTrackingDetailDrawer
        row={selectedRow}
        onClose={() => setSelectedRow(null)}
        storePlatform={storePlatform}
      />
    </ClaimCenterV2PageShell>
  );
}
