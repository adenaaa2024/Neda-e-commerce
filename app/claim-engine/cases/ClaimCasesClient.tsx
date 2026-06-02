"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimEngineHubNav } from "@/components/claim-engine/ClaimEngineHubNav";
import { useUserRole } from "@/components/UserRoleContext";
import {
  CLAIM_FLOW_STAGE_BADGE_CLASS,
  CLAIM_FLOW_STAGE_LABELS,
  type ClaimFlowStage,
} from "@/lib/claim-flow-status-badges";
import { listClaimCasesForOrganization, type ClaimCaseListRow } from "../claim-cases-actions";
import { promoteClaimCaseToSubmission } from "../claim-case-promote-actions";

function caseFlowStage(row: ClaimCaseListRow): ClaimFlowStage {
  if (row.submission_report_url) return "pdf_ready";
  if (row.claim_submission_id) return "ready_for_submission";
  return "case_created";
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
      setMessage({ ok: false, text: res.error ?? res.skipped_reason ?? "Promote failed." });
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <ClaimEngineHubNav />
      <header className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight">Claim cases</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Operator claim cases from physical scans. Promote a case to the submission queue to generate the PDF
          evidence package — no marketplace auto-submit.
        </p>
      </header>

      {message ? (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            message.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30"
              : "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/30"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading cases…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No claim cases yet. Create drafts from the{" "}
          <Link href="/returns/claims" className="font-medium text-violet-600 underline dark:text-violet-400">
            draft pool
          </Link>
          .
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Case</th>
                <th className="px-3 py-2">Issue</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Flow</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const stage = caseFlowStage(row);
                return (
                  <tr key={row.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{row.id.slice(0, 8)}…</td>
                    <td className="px-3 py-2">{row.scanner_issue_type ?? "—"}</td>
                    <td className="px-3 py-2 capitalize">{row.status}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${CLAIM_FLOW_STAGE_BADGE_CLASS[stage]}`}
                      >
                        {CLAIM_FLOW_STAGE_LABELS[stage]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!row.claim_submission_id ? (
                        <button
                          type="button"
                          disabled={busyId === row.id}
                          onClick={() => void promote(row.id)}
                          className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                        >
                          {busyId === row.id ? "…" : "Create submission + PDF"}
                        </button>
                      ) : (
                        <Link
                          href="/claim-engine"
                          className="text-xs font-semibold text-sky-600 hover:underline dark:text-sky-400"
                        >
                          View in queue
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
