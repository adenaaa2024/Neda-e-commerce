"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import type { ClaimEvidencePreviewEdge } from "@/lib/claim-evidence-preview";
import type { ClaimEvidenceEdgeReviewStatus } from "@/lib/claim-evidence-edge-review";

import { EdgeRow } from "./ClaimEvidenceViewerEdgeRow";

type Props = {
  edge: ClaimEvidencePreviewEdge;
  organizationId: string;
  draftId: string;
  reviewEnabled: boolean;
  onReviewed: () => void;
};

function reviewBadgeClass(status: ClaimEvidenceEdgeReviewStatus): string {
  switch (status) {
    case "accepted":
      return "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100";
    case "rejected":
      return "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-100";
    default:
      return "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
  }
}

export function PersistedEdgeReviewRow({
  edge,
  organizationId,
  draftId,
  reviewEnabled,
  onReviewed,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const edgeUuid = edge.reference_edge_id ?? edge.edge_id.replace(/^persisted:/, "");
  const status = edge.operator_review_status ?? "needs_review";

  async function submit(next: ClaimEvidenceEdgeReviewStatus) {
    if (!reviewEnabled || !edgeUuid) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/claims/drafts/${encodeURIComponent(draftId)}/evidence-edges/${encodeURIComponent(edgeUuid)}/review`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organization_id: organizationId,
            status: next,
          }),
        },
      );
      const j = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setErr(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        return;
      }
      onReviewed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 px-0.5">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${reviewBadgeClass(status)}`}
        >
          {status.replace(/_/g, " ")}
        </span>
        {reviewEnabled ? (
          <>
            <button
              type="button"
              disabled={busy || status === "accepted"}
              onClick={() => void submit("accepted")}
              className="rounded border border-emerald-400/60 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-200 dark:hover:bg-emerald-950/40"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={busy || status === "rejected"}
              onClick={() => void submit("rejected")}
              className="rounded border border-rose-400/60 px-1.5 py-0.5 text-[10px] font-medium text-rose-800 hover:bg-rose-50 disabled:opacity-40 dark:text-rose-200 dark:hover:bg-rose-950/40"
            >
              Reject
            </button>
            <button
              type="button"
              disabled={busy || status === "needs_review"}
              onClick={() => void submit("needs_review")}
              className="rounded border border-amber-400/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-40 dark:text-amber-200 dark:hover:bg-amber-950/40"
            >
              Needs review
            </button>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" /> : null}
          </>
        ) : null}
      </div>
      {err ? <p className="text-[10px] text-rose-600">{err}</p> : null}
      <EdgeRow edge={edge} organizationId={organizationId} />
    </li>
  );
}
