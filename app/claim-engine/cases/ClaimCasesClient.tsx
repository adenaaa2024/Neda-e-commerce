"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimEngineEmptyState } from "@/components/claim-engine/ClaimEngineEmptyState";
import { ClaimEnginePageShell } from "@/components/claim-engine/ClaimEnginePageShell";
import { ClaimFlowBadge } from "@/components/claim-engine/ClaimFlowBadge";
import {
  CLAIM_ENGINE_BANNER_ERROR_CLASS,
  CLAIM_ENGINE_BANNER_SUCCESS_CLASS,
  CLAIM_ENGINE_BTN_PRIMARY,
  CLAIM_ENGINE_CARD_CLASS,
  CLAIM_ENGINE_KPI_CARD_CLASS,
  CLAIM_ENGINE_KPI_HINT_CLASS,
  CLAIM_ENGINE_KPI_LABEL_CLASS,
  CLAIM_ENGINE_KPI_VALUE_CLASS,
  CLAIM_ENGINE_MAIN_CLASS,
  CLAIM_ENGINE_TABLE_CLASS,
  CLAIM_ENGINE_TABLE_HEAD_CLASS,
  CLAIM_ENGINE_TABLE_ROW_CLASS,
} from "@/components/claim-engine/claim-engine-ui";
import { useUserRole } from "@/components/UserRoleContext";
import type { ClaimFlowStage } from "@/lib/claim-flow-status-badges";
import { listClaimCasesForOrganization, type ClaimCaseListRow } from "../claim-cases-actions";
import { promoteClaimCaseToSubmission } from "../claim-case-promote-actions";

function caseFlowStage(row: ClaimCaseListRow): ClaimFlowStage {
  if (row.submission_report_url) return "pdf_ready";
  if (row.claim_submission_id) return "ready_for_submission";
  const st = String(row.status ?? "").trim().toLowerCase();
  return st === "open" ? "case_ready" : "case_built";
}

export function ClaimCasesClient() {
  const { actorUserId, organizationId } = useUserRole();
  const [rows, setRows] = useState<ClaimCaseListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const tenant = { actorProfileId: actorUserId, filterOrganizationId: organizationId };

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listClaimCasesForOrganization(tenant);
    setLoading(false);
    if (res.ok) setRows(res.rows);
    else setMessage({ ok: false, text: res.error ?? "Failed to load cases." });
  }, [actorUserId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const promote = async (caseId: string) => {
    setBusyId(caseId);
    setMessage(null);
    const res = await promoteClaimCaseToSubmission(caseId, {
      tenant,
      actorProfileId: actorUserId,
      generatePdf: true,
    });
    setBusyId(null);
    if (res.ok) {
      setMessage({
        ok: true,
        text: `Submission ${res.claim_submission_id?.slice(0, 8)}…${res.pdf_generated ? " — PDF ready" : ""}`,
      });
      void load();
    } else {
      setMessage({
        ok: false,
        text:
          res.error ??
          (res.gate ? `${res.gate.display_label}: ${res.gate.display_hint}` : null) ??
          res.skipped_reason ??
          "Promote failed.",
      });
    }
  };

  const readyCount = rows.filter((r) => !r.claim_submission_id).length;
  const linkedCount = rows.filter((r) => r.claim_submission_id).length;

  return (
    <main className={CLAIM_ENGINE_MAIN_CLASS}>
    <ClaimEnginePageShell
      title="Cases"
      description="Internal claim packets before marketplace submission. Promote to Submission queue to generate the PDF evidence package."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
          <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Ready to promote</p>
          <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{readyCount}</p>
          <p className={CLAIM_ENGINE_KPI_HINT_CLASS}>Open cases without a submission</p>
        </div>
        <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
          <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>In submission queue</p>
          <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{linkedCount}</p>
          <p className={CLAIM_ENGINE_KPI_HINT_CLASS}>
            <Link href="/claim-engine" className="claim-engine-link">
              View submission queue
            </Link>
          </p>
        </div>
      </div>

      {message ? (
        <div className={message.ok ? CLAIM_ENGINE_BANNER_SUCCESS_CLASS : CLAIM_ENGINE_BANNER_ERROR_CLASS}>
          {message.text}
        </div>
      ) : null}

      {loading ? (
        <p className="claim-engine-loading flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading cases…
        </p>
      ) : rows.length === 0 ? (
        <ClaimEngineEmptyState
          title="No claim cases yet"
          description="Select physical scans in the draft pool and use Create draft case. Each case can bundle multiple return items with the same issue or grouping."
          action={{ href: "/returns/claims", label: "Open draft pool" }}
        />
      ) : (
        <>
        <div className={`hidden md:block ${CLAIM_ENGINE_CARD_CLASS}`}>
          <table className={CLAIM_ENGINE_TABLE_CLASS}>
            <thead className={CLAIM_ENGINE_TABLE_HEAD_CLASS}>
              <tr>
                <th className="px-4 py-3">Case</th>
                <th className="px-4 py-3">Issue</th>
                <th className="px-4 py-3">Workflow</th>
                <th className="px-4 py-3">Flow</th>
                <th className="px-4 py-3 text-right">Next step</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const stage = caseFlowStage(row);
                return (
                  <tr key={row.id} className={CLAIM_ENGINE_TABLE_ROW_CLASS}>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-300">{row.id.slice(0, 8)}…</td>
                    <td className="px-4 py-3 text-sm">{row.scanner_issue_type ?? "—"}</td>
                    <td className="px-4 py-3 text-sm capitalize text-muted-foreground">{row.status}</td>
                    <td className="px-4 py-3">
                      <ClaimFlowBadge stage={stage} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!row.claim_submission_id ? (
                        <div className="flex flex-col items-end gap-1">
                          <button
                            type="button"
                            disabled={busyId === row.id || !row.submission_readiness.allowed}
                            title={row.submission_readiness.display_hint}
                            onClick={() => void promote(row.id)}
                            className={CLAIM_ENGINE_BTN_PRIMARY}
                          >
                            {busyId === row.id ? "Working…" : "Promote to submission"}
                          </button>
                          {!row.submission_readiness.allowed ? (
                            <span className="max-w-[14rem] text-right text-[10px] text-amber-700 dark:text-amber-300">
                              {row.submission_readiness.display_label}: {row.submission_readiness.display_hint}
                            </span>
                          ) : (
                            <span className="text-[10px] text-emerald-700 dark:text-emerald-300">
                              {row.submission_readiness.display_label}
                            </span>
                          )}
                        </div>
                      ) : (
                        <Link
                          href="/claim-engine"
                          className="claim-engine-link text-xs"
                        >
                          In submission queue
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 md:hidden">
          {rows.map((row) => {
            const stage = caseFlowStage(row);
            return (
              <div
                key={row.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/70"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-400">{row.id.slice(0, 8)}…</span>
                  <ClaimFlowBadge stage={stage} />
                </div>
                <p className="mt-2 text-sm">{row.scanner_issue_type ?? "—"}</p>
                <p className="text-xs capitalize text-muted-foreground">{row.status}</p>
                <div className="mt-3">
                  {!row.claim_submission_id ? (
                    <>
                      <button
                        type="button"
                        disabled={busyId === row.id || !row.submission_readiness.allowed}
                        title={row.submission_readiness.display_hint}
                        onClick={() => void promote(row.id)}
                        className={`${CLAIM_ENGINE_BTN_PRIMARY} w-full justify-center`}
                      >
                        {busyId === row.id ? "Working…" : "Promote to submission"}
                      </button>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {row.submission_readiness.allowed
                          ? row.submission_readiness.display_label
                          : `${row.submission_readiness.display_label}: ${row.submission_readiness.display_hint}`}
                      </p>
                    </>
                  ) : (
                    <Link
                      href="/claim-engine"
                      className="claim-engine-link text-xs"
                    >
                      In submission queue
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
    </ClaimEnginePageShell>
    </main>
  );
}
