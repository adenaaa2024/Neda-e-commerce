"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import type { ClaimEvidenceEdgeReviewStatus } from "@/lib/claim-evidence-edge-review";

type Props = {
  organizationId: string;
  draftId: string;
  reviewEnabled: boolean;
  onDone: () => void;
};

export function PersistedAllBulkReview({ organizationId, draftId, reviewEnabled, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!reviewEnabled) return null;

  async function bulk(status: ClaimEvidenceEdgeReviewStatus) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/claims/drafts/${encodeURIComponent(draftId)}/evidence-edges/bulk-review`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organization_id: organizationId,
            status,
            scope: "all",
          }),
        },
      );
      const j = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setErr(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        return;
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Bulk review failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-emerald-200/80 bg-emerald-50/40 px-2 py-1.5 dark:border-emerald-900/50 dark:bg-emerald-950/20">
      <span className="text-[10px] font-medium text-emerald-900 dark:text-emerald-100">Bulk all edges:</span>
      {(["accepted", "rejected", "needs_review"] as const).map((s) => (
        <button
          key={s}
          type="button"
          disabled={busy}
          onClick={() => void bulk(s)}
          className="rounded border border-emerald-400/60 bg-white px-2 py-0.5 text-[10px] font-medium capitalize text-emerald-900 hover:bg-emerald-50 disabled:opacity-50 dark:bg-slate-900 dark:text-emerald-100"
        >
          {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null}
          {s.replace(/_/g, " ")}
        </button>
      ))}
      {err ? <span className="text-[10px] text-rose-600">{err}</span> : null}
    </div>
  );
}
