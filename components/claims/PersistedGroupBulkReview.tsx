"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import type { ClaimEvidenceEdgeReviewStatus } from "@/lib/claim-evidence-edge-review";

type Props = {
  organizationId: string;
  draftId: string;
  groupKey: string;
  reviewEnabled: boolean;
  onDone: () => void;
};

export function PersistedGroupBulkReview({
  organizationId,
  draftId,
  groupKey,
  reviewEnabled,
  onDone,
}: Props) {
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
            scope: "group",
            group_key: groupKey,
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
    <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-emerald-200/50 px-2 py-1.5 dark:border-emerald-900/40">
      <span className="text-[10px] text-slate-500">Bulk group:</span>
      {(["accepted", "rejected", "needs_review"] as const).map((s) => (
        <button
          key={s}
          type="button"
          disabled={busy}
          onClick={() => void bulk(s)}
          className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium capitalize text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
        >
          {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null}
          {s.replace(/_/g, " ")}
        </button>
      ))}
      {err ? <span className="text-[10px] text-rose-600">{err}</span> : null}
    </div>
  );
}
