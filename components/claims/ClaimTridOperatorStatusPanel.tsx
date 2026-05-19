"use client";

import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  buildOperatorStatusSummary,
  OPERATOR_STATUS_LABELS,
  readCopiedToAmazonFormAt,
  writeCopiedToAmazonFormAt,
  type ClaimTridOperatorStatusSummary,
} from "@/lib/claim-trid-operator-status";
import type { ClaimEvidenceEdgeReviewSummary } from "@/lib/claim-evidence-edge-review";
import type { TridCandidateOutcome } from "@/lib/claim-trid-candidates-types";

type Props = {
  organizationId: string;
  draftId: string;
};

export function ClaimTridOperatorStatusPanel({ organizationId, draftId }: Props) {
  const [summary, setSummary] = useState<ClaimTridOperatorStatusSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [graphRes, refRes] = await Promise.all([
        fetch(
          `/api/claims/drafts/${encodeURIComponent(draftId)}/evidence-graph?organization_id=${encodeURIComponent(organizationId)}&include_persisted_edges=true`,
          { credentials: "include" },
        ),
        fetch(
          `/api/claims/drafts/${encodeURIComponent(draftId)}/reference-candidates?organization_id=${encodeURIComponent(organizationId)}`,
          { credentials: "include" },
        ),
      ]);

      const graphJ = (await graphRes.json()) as {
        persisted_edges?: { review_summary?: ClaimEvidenceEdgeReviewSummary };
        error?: string;
      };
      const refJ = (await refRes.json()) as {
        outcome?: TridCandidateOutcome;
        candidate_count?: number;
        error?: string;
      };

      if (!graphRes.ok) {
        setSummary(null);
        setError(typeof graphJ.error === "string" ? graphJ.error : `Graph HTTP ${graphRes.status}`);
        return;
      }

      const review: ClaimEvidenceEdgeReviewSummary = graphJ.persisted_edges?.review_summary ?? {
        accepted: 0,
        rejected: 0,
        needs_review: 0,
        total: 0,
      };

      setSummary(
        buildOperatorStatusSummary({
          edgeReview: review,
          tridOutcome: refJ.outcome ?? null,
          referenceCandidateCount: refJ.candidate_count ?? 0,
          copiedToAmazonFormAt: readCopiedToAmazonFormAt(draftId),
        }),
      );
    } catch (e) {
      setSummary(null);
      setError(e instanceof Error ? e.message : "Failed to load operator statuses");
    } finally {
      setLoading(false);
    }
  }, [draftId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const markCopied = () => {
    writeCopiedToAmazonFormAt(draftId);
    void load();
  };

  if (loading) {
    return (
      <section className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading operator statuses…
      </section>
    );
  }

  if (error || !summary) {
    return (
      <section className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-muted-foreground">
        {error ?? "No status summary"}
      </section>
    );
  }

  const rs = summary.edge_review;

  return (
    <section className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-900/50">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Operator statuses</h3>
      <p className="text-[10px] text-slate-500">
        Edge review is persisted. &quot;Copied to Amazon form&quot; is stored in this browser session until a DB column is
        approved.
      </p>
      <div className="flex flex-wrap gap-2">
        {(["accepted", "rejected", "needs_review"] as const).map((s) => (
          <span
            key={s}
            className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-medium dark:border-slate-600 dark:bg-slate-900"
          >
            {OPERATOR_STATUS_LABELS[s]}: {rs[s]}
          </span>
        ))}
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            summary.copied_to_amazon_form_at
              ? "border-sky-400 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/50"
              : "border-slate-300 bg-white dark:border-slate-600"
          }`}
        >
          {OPERATOR_STATUS_LABELS.copied_to_amazon_form}
          {summary.copied_to_amazon_form_at ? ": yes" : ": —"}
        </span>
      </div>
      <p className="text-[10px] text-slate-600 dark:text-slate-400">
        TRID outcome: <span className="font-mono">{summary.trid_outcome ?? "—"}</span> ·{" "}
        {summary.reference_candidate_count} reference candidate(s)
      </p>
      {!summary.copied_to_amazon_form_at ? (
        <button
          type="button"
          onClick={markCopied}
          className="inline-flex items-center gap-1 rounded border border-sky-400 bg-white px-2 py-1 text-[10px] font-medium text-sky-800 hover:bg-sky-50 dark:border-sky-600 dark:bg-slate-900 dark:text-sky-200"
        >
          <Check className="h-3 w-3" />
          Mark copied to Amazon form
        </button>
      ) : (
        <p className="text-[10px] text-sky-700 dark:text-sky-300">
          Marked copied at {new Date(summary.copied_to_amazon_form_at).toLocaleString()}
        </p>
      )}
    </section>
  );
}
