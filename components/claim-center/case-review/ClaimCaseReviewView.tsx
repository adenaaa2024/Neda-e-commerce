"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterFinancialNav } from "@/components/claim-center/financial/ClaimCenterFinancialNav";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import type { ClaimCaseReviewPayload, ClaimCaseReviewRow } from "@/lib/claims/pilot/claim-case-review-readmodel";
import {
  DEFAULT_CASE_REVIEW_FILTER_STATE,
  caseReviewApiParams,
  summarizeCaseReviewRows,
  type ClaimCaseReviewFilterState,
} from "@/lib/claims/pilot/claim-case-review-ui-contract";

import { ClaimCaseReviewDetailDrawer } from "./ClaimCaseReviewDetailDrawer";
import { ClaimCaseReviewDisabledActions } from "./ClaimCaseReviewDisabledActions";
import { ClaimCaseReviewFilters } from "./ClaimCaseReviewFilters";
import { ClaimCaseReviewSummaryCards } from "./ClaimCaseReviewSummary";
import { ClaimCaseReviewTable } from "./ClaimCaseReviewTable";

const PAGE_CONTRACT = {
  id: "pool" as const,
  route: "/claim-center/case-review",
  navLabel: "Case review",
  question: "Are the pilot-created claim cases correct before filing packet or PDF planning?",
  dataSource: "GET /api/claims/center/case-review — read-only pilot claim_cases",
  appearsHere:
    "Open pilot cases scoped by pilot_case_run_id with lines, packet snapshot, money lanes, and attestation.",
  whatToDoNext:
    "Inspect each case in the detail drawer. Submit, PDF, and close actions stay disabled until bridge approval.",
  whyEmpty: "Pilot cases may be filtered out, closed, or the pilot_case_run_id does not match this store.",
  helper: "Read-only — no claim_cases writes, no submissions, no PDF generation.",
};

export function ClaimCaseReviewView() {
  const { fetchJson, storeId } = useClaimCenter();
  const [filters, setFilters] = useState<ClaimCaseReviewFilterState>(DEFAULT_CASE_REVIEW_FILTER_STATE);
  const [appliedFilters, setAppliedFilters] = useState<ClaimCaseReviewFilterState>(
    DEFAULT_CASE_REVIEW_FILTER_STATE,
  );
  const [payload, setPayload] = useState<ClaimCaseReviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<ClaimCaseReviewRow | null>(null);

  const loadCases = useCallback(async () => {
    if (!storeId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = caseReviewApiParams(appliedFilters);
      const data = await fetchJson<ClaimCaseReviewPayload>("/api/claims/center/case-review", params);
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load case review.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId, appliedFilters]);

  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  const rows = payload?.rows ?? [];
  const summary = useMemo(() => payload?.summary ?? summarizeCaseReviewRows(rows), [payload?.summary, rows]);

  const applyFilters = () => {
    setAppliedFilters(filters);
    setSelectedRow(null);
  };

  const resetFilters = () => {
    setFilters(DEFAULT_CASE_REVIEW_FILTER_STATE);
    setAppliedFilters(DEFAULT_CASE_REVIEW_FILTER_STATE);
    setSelectedRow(null);
  };

  const capMismatch =
    payload != null && payload.summary.open_cases !== payload.expected_pilot_cap;

  return (
    <ClaimCenterV2PageShell contract={PAGE_CONTRACT}>
      <ClaimCenterFinancialNav />

      <div className="claim-center-card mb-4 rounded-xl border border-violet-500/25 bg-violet-500/10 px-4 py-3 text-xs">
        <p className="font-semibold text-violet-900 dark:text-violet-100">Pilot case review (read-only)</p>
        <p className="mt-1 opacity-90">
          Wired to <code className="text-[10px]">GET /api/claims/center/case-review</code>. Inspect
          pilot-created cases before PDF or submission planning.
        </p>
      </div>

      {capMismatch ? (
        <div className="claim-center-card mb-4 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:text-amber-100">
          Pilot open case count ({payload?.summary.open_cases}) differs from approved cap ({payload?.expected_pilot_cap}).
          Remediation required before filing planning — see POST-VERIFY evidence.
        </div>
      ) : null}

      <div className="mb-4">
        <ClaimCenterBridgePhaseNotice />
      </div>

      <ClaimCaseReviewFilters
        filters={filters}
        onChange={setFilters}
        onApply={applyFilters}
        onReset={resetFilters}
      />

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading pilot cases…
        </div>
      ) : error ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </p>
      ) : (
        <>
          <div className="mb-6">
            <ClaimCaseReviewSummaryCards
              summary={summary}
              pilotCaseRunId={payload?.pilot_case_run_id ?? appliedFilters.pilot_case_run_id}
            />
          </div>

          <div className="mb-4">
            <ClaimCaseReviewDisabledActions />
          </div>

          <ClaimCaseReviewTable
            rows={rows}
            selectedId={selectedRow?.id ?? null}
            onSelect={setSelectedRow}
          />
        </>
      )}

      <ClaimCaseReviewDetailDrawer
        row={selectedRow}
        onClose={() => setSelectedRow(null)}
        pilotCaseRunId={appliedFilters.pilot_case_run_id}
        intakeRunId={appliedFilters.intake_run_id}
        fetchJson={fetchJson}
      />
    </ClaimCenterV2PageShell>
  );
}
