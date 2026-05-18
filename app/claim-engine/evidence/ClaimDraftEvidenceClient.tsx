"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ClaimEvidenceViewer } from "@/components/claims/ClaimEvidenceViewer";

type Props = {
  organizationId: string;
  draftId: string;
};

export function ClaimDraftEvidenceClient({ organizationId, draftId }: Props) {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/claims/drafts/${encodeURIComponent(draftId)}/evidence-graph?organization_id=${encodeURIComponent(organizationId)}&include_persisted_edges=true`,
        { credentials: "include" },
      );
      const j = (await res.json()) as unknown as Record<string, unknown>;
      if (!res.ok) {
        setPayload(null);
        setError(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        return;
      }
      setPayload(j);
    } catch (e) {
      setPayload(null);
      setError(e instanceof Error ? e.message : "Failed to load evidence");
    } finally {
      setLoading(false);
    }
  }, [draftId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const inboxLink =
    typeof payload?.inbox_deep_link === "string" && payload.inbox_deep_link ? payload.inbox_deep_link : null;
  const candidateId =
    typeof payload?.claim_candidate_id === "string" ? payload.claim_candidate_id : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 text-slate-900 dark:text-slate-100">
      <header className="space-y-2 border-b border-slate-200 pb-4 dark:border-slate-700">
        <p className="text-xs text-slate-500">
          <Link href="/claim-engine/inbox" className="text-sky-600 hover:underline dark:text-sky-400">
            Claim Inbox
          </Link>
          {" · "}
          <span className="font-medium text-slate-700 dark:text-slate-300">Draft evidence</span>
        </p>
        <h1 className="text-lg font-semibold">Persisted evidence viewer</h1>
        <p className="font-mono text-[11px] text-slate-600 dark:text-slate-400">draft_id: {draftId}</p>
        {candidateId ? (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">
            Linked inbox candidate:{" "}
            <Link href={inboxLink ?? "#"} className="font-mono underline">
              {candidateId}
            </Link>
          </p>
        ) : (
          <p className="text-xs text-amber-800 dark:text-amber-200">
            No legacy <code className="rounded bg-amber-100 px-1 dark:bg-amber-950">claim_candidates</code> row for this
            draft — use this page as the deep link.
          </p>
        )}
      </header>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin text-sky-500" />
          Loading evidence graph…
        </div>
      ) : error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      ) : payload ? (
        <ClaimEvidenceViewer payload={payload} organizationId={organizationId} />
      ) : null}
    </div>
  );
}
