"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { ClaimCenterFinancialNav } from "@/components/claim-center/financial/ClaimCenterFinancialNav";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  moneyLaneForSubmission,
  parseCogsCoverageRatio,
} from "@/lib/claims/submission/claim-money-lane-profit-loss-ui-contract";
import {
  DEFAULT_REIMBURSEMENT_TRACKING_FILTERS,
  REIMBURSEMENT_TRACKING_PAGE_CONTRACT,
  filterReimbursementTrackingRows,
  reimbursementTrackingApiParams,
  type ReimbursementTrackingFilterState,
  type ReimbursementTrackingUiPayload,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import type { ReimbursementTrackingSimulationUiPayload } from "@/lib/claims/submission/claim-pilot-simulated-completion-v1";

import { ReimbursementTrackingDetailDrawer } from "./ReimbursementTrackingDetailDrawer";
import { ReimbursementTrackingDisabledActions } from "./ReimbursementTrackingDisabledActions";
import { ReimbursementTrackingFilters } from "./ReimbursementTrackingFilters";
import { ReimbursementTrackingHeader } from "./ReimbursementTrackingHeader";
import { ReimbursementTrackingSummaryCards } from "./ReimbursementTrackingSummaryCards";
import { ReimbursementTrackingTable } from "./ReimbursementTrackingTable";
import { ReimbursementTrackingWorkflowStrip } from "./ReimbursementTrackingWorkflowStrip";

export function ReimbursementTrackingView() {
  const searchParams = useSearchParams();
  const simulationMode = searchParams.get("simulation") === "1";
  const { fetchJson, storeId, stores } = useClaimCenter();
  const [filters, setFilters] = useState<ReimbursementTrackingFilterState>(
    DEFAULT_REIMBURSEMENT_TRACKING_FILTERS,
  );
  const [appliedFilters, setAppliedFilters] = useState<ReimbursementTrackingFilterState>(
    DEFAULT_REIMBURSEMENT_TRACKING_FILTERS,
  );
  const [payload, setPayload] = useState<ReimbursementTrackingUiPayload | null>(null);
  const [simulationBanner, setSimulationBanner] = useState<
    ReimbursementTrackingSimulationUiPayload["simulation_banner"] | null
  >(null);
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
      if (simulationMode) {
        const sim = await fetchJson<ReimbursementTrackingSimulationUiPayload>(
          "/api/claims/center/reimbursement-tracking/simulation",
          params,
        );
        setPayload(sim.tracking);
        setSimulationBanner(sim.simulation_banner);
      } else {
        const data = await fetchJson<ReimbursementTrackingUiPayload>(
          "/api/claims/center/reimbursement-tracking",
          params,
        );
        setPayload(data);
        setSimulationBanner(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reimbursement tracking.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId, appliedFilters, simulationMode]);

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
  const moneySummary = payload?.money_lane?.summary_cards;
  const cogsRatio = moneySummary ? parseCogsCoverageRatio(moneySummary.cogs_coverage) : null;
  const cogsMissingCount = moneySummary?.recovery_unknown_count ?? 0;
  const cogsAppliedCount = moneySummary?.cogs_known_count ?? 0;
  const postCogsApplied = cogsRatio != null && cogsRatio.known > 0;
  const incompleteMoney =
    payload != null &&
    payload.previews.some((p) => p.estimated_amount == null && p.recovery_value == null) &&
    !postCogsApplied;

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
          <ReimbursementTrackingHeader payload={payload} simulationBanner={simulationBanner} />

          {simulationMode ? (
            <p className="rounded-lg border border-violet-500/35 bg-violet-500/10 px-4 py-2 text-xs text-violet-950 dark:text-violet-100">
              Viewing simulation overlay only.{" "}
              <Link href="/claim-center/reimbursement-tracking" className="font-semibold underline">
                Exit simulation mode
              </Link>
            </p>
          ) : (
            <p className="text-xs opacity-70">
              <Link href="/claim-center/reimbursement-tracking?simulation=1" className="underline">
                Open simulation demo
              </Link>{" "}
              (not production data — no DB writes)
            </p>
          )}

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

              {postCogsApplied ? (
                <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-950 dark:text-emerald-100">
                  <p className="font-semibold">
                    Approved COGS applied on {cogsAppliedCount} pilot submission
                    {cogsAppliedCount === 1 ? "" : "s"} — recovery value uses approved unit cost, not sale price.
                  </p>
                  {cogsMissingCount > 0 ? (
                    <p className="mt-1 opacity-90">
                      {cogsMissingCount} submission{cogsMissingCount === 1 ? "" : "s"} still missing COGS.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {cogsMissingCount > 0 && !simulationMode ? (
                <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-xs text-amber-950 dark:text-amber-100">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="h-3.5 w-3.5" /> COGS missing on {cogsMissingCount} pilot submission
                    {cogsMissingCount === 1 ? "" : "s"}
                  </p>
                  <p className="mt-1 opacity-90">
                    Recovery value shows Unknown until approved unit cost is entered. Sale price is not used as COGS.
                  </p>
                  <Link
                    href="/claim-center/reimbursement-tracking/cogs"
                    className="mt-2 inline-flex rounded-md border border-amber-600/40 bg-white/60 px-3 py-1.5 text-[11px] font-semibold hover:bg-white/80 dark:bg-black/20 dark:text-amber-100"
                  >
                    Open COGS Entry (dry-run)
                  </Link>
                </div>
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
                moneyLane={payload.money_lane}
              />
            </>
          )}
        </div>
      ) : null}

      <ReimbursementTrackingDetailDrawer
        row={selectedRow}
        moneyPreview={
          selectedRow
            ? moneyLaneForSubmission(payload?.money_lane, selectedRow.claim_submission_id)
            : null
        }
        onClose={() => setSelectedRow(null)}
        storePlatform={storePlatform}
        fetchJson={fetchJson}
      />
    </ClaimCenterV2PageShell>
  );
}
