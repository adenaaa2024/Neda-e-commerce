"use client";

import { useCallback, useState } from "react";
import { Briefcase, Loader2 } from "lucide-react";

import type { ClaimCaseCreationPreviewV1Payload } from "@/lib/claims/case-creation/claim-case-creation-preview-v1";
import {
  BULK_CASE_PREVIEW_BUTTON_LABEL,
  CASE_CREATION_PREVIEW_API_PATH,
  CASE_PREVIEW_BULK_MODE_LABELS,
  CASE_PREVIEW_RECOMMENDED_ACTION_LABELS,
  casePreviewApiParams,
  deriveCasePreviewActionTone,
  productIdentifiersLabel,
  type CasePreviewBulkMode,
} from "@/lib/claims/pilot/claim-case-creation-preview-ui-contract";
import { formatPilotMoney } from "@/lib/claims/pilot/claim-pilot-review-ui-contract";
import { claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";

type Props = {
  intakeRunId: string;
  selectedCandidateIds: string[];
  totalPilotCount: number;
  fetchJson: <T>(path: string, extra?: Record<string, string>) => Promise<T>;
};

export function ClaimPilotReviewBulkCasePreviewPanel({
  intakeRunId,
  selectedCandidateIds,
  totalPilotCount,
  fetchJson,
}: Props) {
  const [mode, setMode] = useState<CasePreviewBulkMode>("all_pilot");
  const [payload, setPayload] = useState<ClaimCaseCreationPreviewV1Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBulk = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPayload(null);
    try {
      if (mode === "selected" && selectedCandidateIds.length === 0) {
        setError("Select at least one candidate in the table to preview selected cases.");
        return;
      }

      const params =
        mode === "selected"
          ? casePreviewApiParams({ candidateIds: selectedCandidateIds, intakeRunId, limit: 50 })
          : casePreviewApiParams({ intakeRunId, limit: 50 });

      const data = await fetchJson<ClaimCaseCreationPreviewV1Payload>(
        CASE_CREATION_PREVIEW_API_PATH,
        params,
      );
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load bulk case previews.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, intakeRunId, mode, selectedCandidateIds]);

  const summary = payload?.summary;
  const showGrouped = mode === "grouped" && summary;

  return (
    <div className="claim-center-card rounded-xl border border-violet-500/25 bg-violet-500/5 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Bulk case creation preview</h3>
        <span className="text-[10px] opacity-50">read-only</span>
      </div>
      <p className="mb-4 text-xs opacity-80">
        Preview proposed <code className="text-[10px]">claim_cases</code> before any write. Grouping follows contract
        default: single candidate → one case.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {(["selected", "all_pilot", "grouped"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
              mode === m ? "border-violet-500/50 bg-violet-500/15" : "opacity-70"
            }`}
          >
            {CASE_PREVIEW_BULK_MODE_LABELS[m]}
            {m === "selected" ? ` (${selectedCandidateIds.length})` : null}
            {m === "all_pilot" ? ` (${totalPilotCount})` : null}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => void loadBulk()}
        disabled={loading}
        className="claim-center-btn inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Briefcase className="h-4 w-4" aria-hidden />
        )}
        {BULK_CASE_PREVIEW_BUTTON_LABEL}
      </button>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 py-4 text-xs opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading bulk previews…
        </div>
      ) : error ? (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-4 text-xs">
          <p className="font-semibold text-red-800 dark:text-red-200">{error}</p>
          <button
            type="button"
            onClick={() => void loadBulk()}
            className="mt-3 rounded-lg border px-2 py-1 text-[10px] font-semibold"
          >
            Retry
          </button>
        </div>
      ) : summary ? (
        <div className="mt-4 space-y-4">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div>
              <dt className="text-[10px] uppercase opacity-55">Evaluated</dt>
              <dd className="font-semibold tabular-nums">{summary.evaluated_candidate_count}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase opacity-55">Proposed cases</dt>
              <dd className="font-semibold tabular-nums">{summary.proposed_case_count}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase opacity-55">Needs review</dt>
              <dd className="font-semibold tabular-nums">{summary.needs_operator_review_count}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase opacity-55">Duplicate risk</dt>
              <dd className="font-semibold tabular-nums">{summary.duplicate_risk_count}</dd>
            </div>
          </dl>

          {showGrouped ? (
            <div className="rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
              <p className="font-semibold">Grouping summary</p>
              <p className="mt-1 opacity-80">
                Mode: {summary.proposed_grouping_summary.mode} · Single-candidate cases:{" "}
                {summary.proposed_grouping_summary.single_candidate_cases} · Grouped:{" "}
                {summary.proposed_grouping_summary.grouped_cases}
              </p>
            </div>
          ) : null}

          {payload.case_previews.length === 0 ? (
            <p className="text-xs opacity-60">No case previews in this scope.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="border-b text-[10px] uppercase opacity-60">
                  <tr>
                    <th className="px-3 py-2">Family</th>
                    <th className="px-3 py-2">Event key</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Recovery</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.case_previews.map((p) => {
                    const tone = deriveCasePreviewActionTone(p.recommended_action);
                    return (
                      <tr key={p.case_preview_id} className="border-b border-black/5 dark:border-white/5">
                        <td className="px-3 py-2">{p.family_key_v3?.replace(/_/g, " ") ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-[10px] max-w-[100px] truncate">
                          {p.source_event_key ?? "—"}
                        </td>
                        <td className="px-3 py-2">{productIdentifiersLabel(p.product_identifiers)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{p.clean_quantity ?? "—"}</td>
                        <td className="px-3 py-2 text-right">{formatPilotMoney(p.recovery_value, null)}</td>
                        <td className="px-3 py-2">
                          <span className={claimCenterBadgeTone(tone)}>
                            {CASE_PREVIEW_RECOMMENDED_ACTION_LABELS[p.recommended_action]}
                          </span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{p.warnings.length || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-4 text-xs opacity-60">
          Choose a scope and load previews to inspect proposed cases at scale.
        </p>
      )}
    </div>
  );
}
