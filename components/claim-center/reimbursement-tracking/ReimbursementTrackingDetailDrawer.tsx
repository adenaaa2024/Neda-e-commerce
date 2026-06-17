"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

import { IdentifierStack } from "@/components/IdentifierStack";
import type { PerSubmissionMoneyPreviewV2 } from "@/lib/claims/submission/claim-money-lane-preview-v2-profit-loss-v1";
import {
  formatTrackingMoney,
  referenceGraphTridWarning,
  referenceGraphVerified,
  reimbursementTrackingStatusLabel,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import { profitIfSoldFromPreview } from "@/lib/claims/submission/claim-money-lane-profit-loss-ui-contract";
import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  CLAIM_CENTER_DETAIL_DRAWER_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";

import { ReimbursementTrackingMoneyTab } from "./ReimbursementTrackingMoneyTab";
import { ReimbursementTrackingManualFilingSection } from "./ReimbursementTrackingManualFilingSection";

type DrawerTab = "overview" | "money" | "evidence" | "raw";

type Props = {
  row: ReimbursementTrackingPreviewRow | null;
  moneyPreview: PerSubmissionMoneyPreviewV2 | null;
  onClose: () => void;
  storePlatform?: string | null;
  fetchJson: <T>(path: string, extra?: Record<string, string>, init?: RequestInit) => Promise<T>;
};

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">{label}</dt>
      <dd className={`mt-0.5 text-sm font-medium ${mono ? "font-mono text-xs break-all" : ""}`}>{value}</dd>
    </div>
  );
}

function MoneyField({ label, value }: { label: string; value: number | null }) {
  return (
    <Field
      label={label}
      value={
        value == null ? (
          <span className="text-amber-700 dark:text-amber-300" title="Unknown values are not treated as zero.">
            Unknown
          </span>
        ) : (
          formatTrackingMoney(value)
        )
      }
    />
  );
}

const TABS: Array<{ id: DrawerTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "money", label: "Money" },
  { id: "evidence", label: "Evidence" },
  { id: "raw", label: "Raw details" },
];

export function ReimbursementTrackingDetailDrawer({
  row,
  moneyPreview,
  onClose,
  storePlatform,
  fetchJson,
}: Props) {
  const [tab, setTab] = useState<DrawerTab>("overview");
  if (!row) return null;

  const verified = referenceGraphVerified(row);
  const tridWarning = referenceGraphTridWarning(row);
  const artifacts = row.export_artifact_paths ?? {};
  const cogsHref = row.fnsku
    ? `/claim-center/reimbursement-tracking/cogs?fnsku=${encodeURIComponent(row.fnsku)}`
    : "/claim-center/reimbursement-tracking/cogs";
  const recoveryValue =
    moneyPreview?.cost_recovery_view.recovery_value.value ?? row.recovery_value;
  const observedReimbursement =
    moneyPreview?.reimbursement_view.observed_reimbursement.value ?? row.observed_reimbursement;
  const openGap = moneyPreview?.open_gap_view.open_recovery_gap.value ?? row.financial_gap;
  const approvedCogs = moneyPreview?.cost_recovery_view.approved_cogs_unit.value ?? null;
  const profitIfSold = moneyPreview ? profitIfSoldFromPreview(moneyPreview) : null;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[400] bg-black/40"
        aria-label="Close detail"
        onClick={onClose}
      />
      <aside className={`${CLAIM_CENTER_DETAIL_DRAWER_CLASS} flex flex-col`} aria-label="Reimbursement detail">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Submission detail</h2>
            <p className="text-[11px] opacity-60">{reimbursementTrackingStatusLabel(row.reimbursement_tracking_status)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 opacity-70 hover:opacity-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b px-4">
          <div className="flex gap-1 overflow-x-auto py-2" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  tab === t.id
                    ? "bg-sky-500/15 text-sky-900 dark:text-sky-100"
                    : "opacity-60 hover:opacity-100"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 text-sm">
          {tab === "overview" ? (
            <div className="space-y-6">
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Claim summary</h3>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <Field label="Claim case ID" value={row.claim_case_id} mono />
                  <Field label="Claim submission ID" value={row.claim_submission_id} mono />
                  <Field label="Family" value={(row.family_key_v3 ?? row.claim_family ?? "—").replace(/_/g, " ")} />
                  <Field label="Submission status" value={row.submission_status ?? "—"} />
                  <Field label="Source event key" value={row.source_event_key ?? "—"} mono />
                  <Field label="Clean quantity" value={row.clean_quantity ?? "—"} />
                </dl>
                {row.not_submitted_to_amazon ? (
                  <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs">
                    Not submitted to Amazon — internal draft record only.
                  </p>
                ) : null}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Product identity</h3>
                <IdentifierStack asin={row.asin} fnsku={row.fnsku} sku={row.sku} storePlatform={storePlatform} />
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Reference graph</h3>
                <div className="mb-2 flex flex-wrap gap-2">
                  {verified ? (
                    <span className={`${claimCenterBadgeTone("success")} inline-flex items-center gap-1`}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> Reference graph present
                    </span>
                  ) : (
                    <span className={claimCenterBadgeTone("warning")}>Reference graph incomplete</span>
                  )}
                </div>
                {tridWarning ? (
                  <p className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                    {tridWarning}
                  </p>
                ) : null}
                {row.detail_preview.reference_graph_lines.length === 0 ? (
                  <p className="text-xs opacity-60">No reference graph lines available.</p>
                ) : (
                  <ul className="space-y-2">
                    {row.detail_preview.reference_graph_lines.map((line, i) => (
                      <li key={`${line.kind}-${line.value}-${i}`} className="rounded-lg border px-3 py-2 text-xs">
                        <span className="font-semibold">{line.kind.replace(/_/g, " ")}</span>
                        <p className="mt-0.5 font-mono text-[10px] break-all">{line.value || "—"}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Quick financial snapshot</h3>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <MoneyField label="Approved COGS unit" value={approvedCogs} />
                  <MoneyField label="Recovery value" value={recoveryValue} />
                  <MoneyField label="Observed reimbursement" value={observedReimbursement} />
                  <MoneyField label="Open gap" value={openGap} />
                  <MoneyField label="Profit if sold" value={profitIfSold} />
                </dl>
                <p className="mt-2 text-xs opacity-70">
                  Values prefer money lane V2 (approved COGS overrides). Open the <strong>Money</strong> tab for
                  full sale, fee, settlement, COGS, and profit/loss formulas.
                </p>
              </section>

              <ReimbursementTrackingManualFilingSection row={row} fetchJson={fetchJson} />
            </div>
          ) : null}

          {tab === "money" ? (
            moneyPreview ? (
              <ReimbursementTrackingMoneyTab money={moneyPreview} cogsHref={cogsHref} />
            ) : (
              <p className="rounded-lg border border-dashed px-4 py-8 text-center text-xs opacity-70">
                Money lane preview unavailable for this submission.
              </p>
            )
          ) : null}

          {tab === "evidence" ? (
            <div className="space-y-6">
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Reimbursement match</h3>
                <Field label="Match confidence" value={<span className="capitalize">{row.match_confidence}</span>} />
                {row.linked_reimbursement_rows.length === 0 ? (
                  <p className="mt-2 rounded-lg border border-dashed px-3 py-4 text-xs opacity-70">
                    No reimbursement matched yet. This is normal before manual filing or Amazon response.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {row.linked_reimbursement_rows.map((r) => (
                      <li key={r.id} className="rounded-lg border px-3 py-2 text-xs">
                        <p className="font-semibold">Reimbursement · {r.match_reason.replace(/_/g, " ")}</p>
                        <p className="font-mono text-[10px]">{r.reference_key ?? r.order_id ?? r.id}</p>
                        <p className="mt-1 tabular-nums">
                          {formatTrackingMoney(r.amount)} · {r.posted_date ?? "—"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Filing packet / export</h3>
                <span className={claimCenterBadgeTone("warning")}>DRAFT ONLY · NOT SUBMITTED</span>
                {Object.keys(artifacts).length === 0 ? (
                  <p className="mt-2 text-xs opacity-60">No export artifact paths recorded.</p>
                ) : (
                  <ul className="mt-2 space-y-1 break-all font-mono text-xs">
                    {Object.entries(artifacts).map(([k, v]) => (
                      <li key={k}>
                        <span className="opacity-60">{k}:</span> {String(v)}
                      </li>
                    ))}
                  </ul>
                )}
                {row.detail_preview.blockers.length > 0 ? (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Blockers: {row.detail_preview.blockers.join(", ")}
                  </div>
                ) : null}
              </section>

              {row.money_warnings.length > 0 ? (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Money warnings</h3>
                  <ul className="list-disc pl-4 text-xs opacity-80">
                    {row.money_warnings.map((w) => (
                      <li key={w}>{w.replace(/_/g, " ")}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <Link
                href={cogsHref}
                className="inline-flex rounded-md border px-3 py-2 text-xs font-semibold hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
              >
                Open COGS entry (dry-run)
              </Link>
            </div>
          ) : null}

          {tab === "raw" ? (
            <pre className="max-h-[70vh] overflow-auto rounded-lg border bg-black/5 p-3 text-[10px] dark:bg-white/5">
              {JSON.stringify({ row, money_preview: moneyPreview }, null, 2)}
            </pre>
          ) : null}
        </div>
      </aside>
    </>
  );
}
