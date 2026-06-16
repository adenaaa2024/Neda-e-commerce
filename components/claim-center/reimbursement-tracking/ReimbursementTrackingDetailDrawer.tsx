"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, X } from "lucide-react";

import { IdentifierStack } from "@/components/IdentifierStack";
import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  deriveNextAction,
  formatTrackingMoney,
  referenceGraphTridWarning,
  referenceGraphVerified,
  reimbursementTrackingStatusLabel,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  CLAIM_CENTER_DETAIL_DRAWER_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";

type Props = {
  row: ReimbursementTrackingPreviewRow | null;
  onClose: () => void;
  storePlatform?: string | null;
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">{title}</h3>
      {children}
    </section>
  );
}

export function ReimbursementTrackingDetailDrawer({ row, onClose, storePlatform }: Props) {
  const [rawOpen, setRawOpen] = useState(false);
  if (!row) return null;

  const verified = referenceGraphVerified(row);
  const tridWarning = referenceGraphTridWarning(row);
  const artifacts = row.export_artifact_paths ?? {};

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

        <div className="flex-1 space-y-6 overflow-y-auto p-4 text-sm">
          <Section title="A. Claim summary">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Claim case ID" value={row.claim_case_id} mono />
              <Field label="Claim submission ID" value={row.claim_submission_id} mono />
              <Field label="Family" value={(row.family_key_v3 ?? row.claim_family ?? "—").replace(/_/g, " ")} />
              <Field label="Submission status" value={row.submission_status ?? "—"} />
              <Field label="Source event key" value={row.source_event_key ?? "—"} mono />
              <Field label="Source event date" value={row.source_event_date ?? "—"} />
              <Field label="Clean quantity" value={row.clean_quantity ?? "—"} />
              <Field
                label="Status explanation"
                value={reimbursementTrackingStatusLabel(row.reimbursement_tracking_status)}
              />
            </dl>
            {row.not_submitted_to_amazon ? (
              <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs">
                Not submitted to Amazon — internal draft record only.
              </p>
            ) : null}
          </Section>

          <Section title="B. Product identity">
            <IdentifierStack
              asin={row.asin}
              fnsku={row.fnsku}
              sku={row.sku}
              storePlatform={storePlatform}
            />
          </Section>

          <Section title="C. Reference graph">
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
              <p className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
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
                    <p className="mt-1 text-[10px] opacity-50">{line.source}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="D. Financial breakdown">
            <dl className="grid gap-3 sm:grid-cols-2">
              <MoneyField label="Estimated amount" value={row.estimated_amount} />
              <MoneyField label="Recovery value" value={row.recovery_value} />
              <MoneyField label="Observed reimbursement" value={row.observed_reimbursement} />
              <MoneyField label="Calculated gap" value={row.financial_gap} />
            </dl>
            <ul className="mt-3 space-y-1 text-xs opacity-80">
              <li>Unknown values are not treated as zero.</li>
              <li>Sale price is not used as COGS.</li>
              <li>Gap is calculated only when both estimated and observed values are known.</li>
            </ul>
            {row.money_warnings.length > 0 ? (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                <p className="font-semibold">Money warnings</p>
                <ul className="mt-1 list-disc pl-4">
                  {row.money_warnings.map((w) => (
                    <li key={w}>{w.replace(/_/g, " ")}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="mt-2 text-xs opacity-70">{row.detail_preview.financial_gap_explanation}</p>
          </Section>

          <Section title="E. Reimbursement match">
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
                    <p className="mt-1 tabular-nums">{formatTrackingMoney(r.amount)} · {r.posted_date ?? "—"}</p>
                  </li>
                ))}
              </ul>
            )}
            {row.linked_transaction_rows.length > 0 ? (
              <div className="mt-3">
                <p className="text-[11px] font-semibold uppercase opacity-60">Matched transactions</p>
                <ul className="mt-1 space-y-2">
                  {row.linked_transaction_rows.map((r) => (
                    <li key={r.id} className="rounded-lg border px-3 py-2 text-xs font-mono">
                      {r.order_id ?? r.id} · {formatTrackingMoney(r.amount)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {row.linked_settlement_rows.length > 0 ? (
              <div className="mt-3">
                <p className="text-[11px] font-semibold uppercase opacity-60">Settlement references</p>
                <ul className="mt-1 space-y-2">
                  {row.linked_settlement_rows.map((r) => (
                    <li key={r.id} className="rounded-lg border px-3 py-2 text-xs font-mono">
                      {r.reference_key ?? r.order_id ?? r.id}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>

          <Section title="F. Filing packet / evidence">
            <span className={claimCenterBadgeTone("warning")}>DRAFT ONLY · NOT SUBMITTED</span>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Packet readiness" value={row.submission_mode ?? "manual_filing"} />
              <Field
                label="Reference graph included"
                value={verified ? "Yes" : "Incomplete"}
              />
            </dl>
            {Object.keys(artifacts).length === 0 ? (
              <p className="mt-2 text-xs opacity-60">No export artifact paths recorded.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs font-mono break-all">
                {Object.entries(artifacts).map(([k, v]) => (
                  <li key={k}>
                    <span className="opacity-60">{k}:</span> {String(v)}
                  </li>
                ))}
              </ul>
            )}
            {row.detail_preview.blockers.length > 0 ? (
              <div className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                Blockers: {row.detail_preview.blockers.join(", ")}
              </div>
            ) : null}
          </Section>

          <Section title="G. Next action">
            <p className="rounded-lg border bg-black/[0.03] px-3 py-3 text-sm font-medium dark:bg-white/[0.03]">
              {deriveNextAction(row)}
            </p>
          </Section>

          <div>
            <button
              type="button"
              onClick={() => setRawOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-semibold opacity-70 hover:opacity-100"
            >
              {rawOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              Raw details
            </button>
            {rawOpen ? (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg border bg-black/5 p-3 text-[10px] dark:bg-white/5">
                {JSON.stringify(row, null, 2)}
              </pre>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
}
