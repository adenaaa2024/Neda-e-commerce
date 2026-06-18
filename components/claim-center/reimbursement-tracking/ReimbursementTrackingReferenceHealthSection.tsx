"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, Workflow } from "lucide-react";

import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import type {
  ReferenceRefreshPreviewResult,
  ReimbursementMatchPreviewResult,
  TridResolverResult,
} from "@/lib/claims/reference/claim-live-reference-api-completion-v1";
import {
  CLAIM_CENTER_DISABLED_BTN,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";

type Props = {
  row: ReimbursementTrackingPreviewRow;
  fetchJson: <T>(path: string, extra?: Record<string, string>, init?: RequestInit) => Promise<T>;
};

function StatusRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
      <span className="opacity-60">{label}</span>
      <span className={`font-medium ${mono ? "font-mono text-[10px] break-all" : ""}`}>{value}</span>
    </div>
  );
}

const CONFIDENCE_TONE: Record<string, "success" | "info" | "warning" | "danger"> = {
  high: "success",
  medium: "info",
  low: "warning",
  none: "danger",
};

export function ReimbursementTrackingReferenceHealthSection({ row, fetchJson }: Props) {
  const [trid, setTrid] = useState<TridResolverResult | null>(null);
  const [tridError, setTridError] = useState<string | null>(null);
  const [tridLoading, setTridLoading] = useState(true);

  const [refresh, setRefresh] = useState<ReferenceRefreshPreviewResult | null>(null);
  const [refreshLoading, setRefreshLoading] = useState(false);

  const [match, setMatch] = useState<ReimbursementMatchPreviewResult | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);

  const caseIdPresent = Boolean(row.future_amazon_case_id);

  const loadTrid = useCallback(async () => {
    setTridLoading(true);
    setTridError(null);
    try {
      const data = await fetchJson<TridResolverResult>(
        "/api/claims/center/references/trid-resolver",
        { claim_submission_id: row.claim_submission_id },
      );
      setTrid(data);
    } catch (e) {
      setTridError(e instanceof Error ? e.message : "TRID resolver failed.");
    } finally {
      setTridLoading(false);
    }
  }, [fetchJson, row.claim_submission_id]);

  useEffect(() => {
    void loadTrid();
  }, [loadTrid]);

  const runRefreshPreview = useCallback(async () => {
    setRefreshLoading(true);
    try {
      const data = await fetchJson<ReferenceRefreshPreviewResult>(
        "/api/claims/center/references/refresh-preview",
        undefined,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claim_submission_id: row.claim_submission_id }),
        },
      );
      setRefresh(data);
    } catch {
      setRefresh(null);
    } finally {
      setRefreshLoading(false);
    }
  }, [fetchJson, row.claim_submission_id]);

  const runMatchPreview = useCallback(async () => {
    if (!caseIdPresent) return;
    setMatchLoading(true);
    try {
      const data = await fetchJson<ReimbursementMatchPreviewResult>(
        "/api/claims/center/reimbursement-match/refresh-preview",
        undefined,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claim_submission_id: row.claim_submission_id }),
        },
      );
      setMatch(data);
    } catch {
      setMatch(null);
    } finally {
      setMatchLoading(false);
    }
  }, [caseIdPresent, fetchJson, row.claim_submission_id]);

  const tridFound = trid?.found && trid.trid;
  const missingRefs = trid?.missing_refs ?? [];

  return (
    <section data-reference-health="v1">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase opacity-60">
        <Workflow className="h-3.5 w-3.5" aria-hidden /> Reference health
      </h3>

      <div className="space-y-3 rounded-lg border bg-black/[0.03] p-3 dark:bg-white/[0.03]">
        {tridLoading ? (
          <p className="text-xs opacity-60">Resolving TRID…</p>
        ) : tridError ? (
          <p className="text-xs text-amber-800 dark:text-amber-200">{tridError}</p>
        ) : trid ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {tridFound ? (
                <span className={`${claimCenterBadgeTone("success")} inline-flex items-center gap-1`}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> TRID resolved
                </span>
              ) : (
                <span className={claimCenterBadgeTone("danger")}>TRID missing</span>
              )}
              <span className={claimCenterBadgeTone(CONFIDENCE_TONE[trid.confidence] ?? "warning")}>
                {trid.confidence} confidence
              </span>
            </div>

            <StatusRow label="TRID" value={trid.trid ?? "—"} mono />
            <StatusRow label="TRID source" value={trid.trid_source.replace(/_/g, " ")} />
            <StatusRow label="Product link" value={trid.resolved_product_id ?? "—"} mono />
            <StatusRow label="Expected package" value={trid.expected_package_id ?? "—"} mono />
            <StatusRow label="Family" value={(trid.family ?? "—").replace(/_/g, " ")} />

            {missingRefs.length > 0 ? (
              <div className="flex items-start gap-1.5 border-t border-black/5 pt-2 text-[11px] text-amber-800 dark:border-white/10 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>Missing refs: {missingRefs.join(", ").replace(/_/g, " ")}</span>
              </div>
            ) : (
              <p className="border-t border-black/5 pt-2 text-[11px] text-emerald-700 dark:border-white/10 dark:text-emerald-300">
                All case-opening references present.
              </p>
            )}
          </>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={runRefreshPreview}
          disabled={refreshLoading}
          className="claim-center-btn inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.03]"
          title="Dry-run reference refresh from already-loaded Amazon tables. No write, no Amazon call."
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshLoading ? "animate-spin" : ""}`} aria-hidden />
          Refresh preview (dry-run)
        </button>

        {caseIdPresent ? (
          <button
            type="button"
            onClick={runMatchPreview}
            disabled={matchLoading}
            className="claim-center-btn inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.03]"
            title="Dry-run post-filing reimbursement match. Does not close claims or write."
          >
            Reimbursement match preview
          </button>
        ) : (
          <button
            type="button"
            disabled
            title="Disabled until a real Amazon Case ID exists on this submission."
            className={`${CLAIM_CENTER_DISABLED_BTN} inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold`}
          >
            Reimbursement match preview
          </button>
        )}
      </div>

      <p className="mt-2 text-[11px] opacity-60">
        Reference actions are dry-run only. No Amazon submission, no DB writes. Live SP-API sync requires future
        explicit approval.
      </p>

      {refresh ? (
        <div className="mt-3 rounded-lg border px-3 py-2 text-xs">
          <p className="mb-1 font-semibold">
            Proposed edges ({refresh.proposed_edges.length}) · dry-run · no write
          </p>
          {refresh.proposed_edges.length === 0 ? (
            <p className="opacity-60">No proposable edges from loaded tables.</p>
          ) : (
            <ul className="space-y-1">
              {refresh.proposed_edges.map((e, i) => (
                <li key={`${e.kind}-${e.value}-${i}`} className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{e.kind.replace(/_/g, " ")}</span>
                  <span className="font-mono text-[10px] break-all opacity-70">{e.value}</span>
                </li>
              ))}
            </ul>
          )}
          {refresh.unresolvable_without_live_sync.length > 0 ? (
            <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-200">
              Needs live sync: {refresh.unresolvable_without_live_sync.join(", ").replace(/_/g, " ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {match ? (
        <div className="mt-3 rounded-lg border px-3 py-2 text-xs">
          <p className="mb-1 font-semibold">Reimbursement match · {match.status}</p>
          {match.blocked_reason ? (
            <p className="text-amber-800 dark:text-amber-200">{match.blocked_reason}</p>
          ) : (
            <ul className="space-y-1">
              {match.proposed_matches.map((m, i) => (
                <li key={`${m.reference}-${i}`} className="flex flex-wrap justify-between gap-2">
                  <span className="font-mono text-[10px] break-all opacity-70">{m.reference}</span>
                  <span className="font-medium">
                    {m.amount == null ? "—" : m.amount} · {m.confidence}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
