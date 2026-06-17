"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";

import type { ClaimCaseReviewRow } from "@/lib/claims/pilot/claim-case-review-readmodel";
import { formatCaseReviewMoney } from "@/lib/claims/pilot/claim-case-review-ui-contract";

import { ClaimCaseReviewFilingPacketSection } from "./ClaimCaseReviewFilingPacketSection";
import { ClaimCaseReviewManualFilingHandoffSection } from "./ClaimCaseReviewManualFilingHandoffSection";

type Props = {
  row: ClaimCaseReviewRow | null;
  onClose: () => void;
  pilotCaseRunId: string;
  intakeRunId: string;
  fetchJson: <T>(path: string, extra?: Record<string, string>) => Promise<T>;
};

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">{label}</dt>
      <dd className={`mt-0.5 text-sm font-medium ${mono ? "font-mono text-xs break-all" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

export function ClaimCaseReviewDetailDrawer({
  row,
  onClose,
  pilotCaseRunId,
  intakeRunId,
  fetchJson,
}: Props) {
  if (!row) return null;

  const packet = row.evidence_packet_snapshot;
  const lanes = row.money_lanes;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 bg-black/40 lg:hidden"
        aria-label="Close detail"
        onClick={onClose}
      />
      <aside
        className="claim-center-card fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l shadow-xl lg:max-w-xl"
        aria-label="Pilot case detail"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Pilot case detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 opacity-70 hover:opacity-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-6 text-sm">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Case metadata</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Case ID" value={row.id} mono />
              <Field label="Idempotency key" value={row.idempotency_key ?? "—"} mono />
              <Field label="Claim source" value={row.claim_source ?? "—"} />
              <Field label="Family V3" value={row.family_key_v3 ?? "—"} />
              <Field label="Claim family" value={row.claim_family ?? "—"} />
              <Field label="Status" value={row.status ?? "—"} />
              <Field label="Pilot run" value={row.pilot_case_run_id ?? "—"} mono />
              <Field label="Intake run" value={row.intake_run_id ?? "—"} mono />
              <Field label="Source event key" value={row.source_event_key ?? "—"} mono />
              <Field label="Created" value={row.created_at ?? "—"} />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Lines</h3>
            {row.lines.length === 0 ? (
              <p className="text-xs opacity-60">No claim lines.</p>
            ) : (
              <ul className="space-y-3">
                {row.lines.map((line) => (
                  <li key={line.id} className="rounded-lg border p-3 text-xs">
                    <p className="font-mono break-all">{line.id}</p>
                    <p className="mt-1">
                      Status {line.status ?? "—"} · Qty expected {line.quantity_expected ?? "—"}
                    </p>
                    <p className="mt-1 opacity-70">
                      {line.line_grain ?? "—"} · {line.discrepancy_kind ?? "—"}
                    </p>
                    <p className="mt-1 font-mono text-[10px] break-all">{line.idempotency_key ?? "—"}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Candidate link</h3>
            {row.candidate_ids.length === 0 ? (
              <p className="text-xs opacity-60">No candidates linked.</p>
            ) : (
              <ul className="space-y-2">
                {row.candidate_ids.map((cid) => (
                  <li key={cid}>
                    <Link
                      href={`/claim-center/pilot-review?highlight=${cid}`}
                      className="font-mono text-xs text-sky-700 underline dark:text-sky-300"
                    >
                      {cid}
                    </Link>
                    <span className="ml-2 text-[10px] opacity-60">→ Pilot review</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Evidence packet snapshot</h3>
            {!packet ? (
              <p className="text-xs opacity-60">No packet snapshot stored.</p>
            ) : (
              <pre className="max-h-48 overflow-auto rounded-lg bg-black/5 p-3 text-[10px] dark:bg-white/5">
                {JSON.stringify(packet, null, 2)}
              </pre>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Reference edges</h3>
            {row.reference_edges.length === 0 ? (
              <p className="text-xs opacity-60">No reference edges materialized.</p>
            ) : (
              <ul className="space-y-2">
                {row.reference_edges.map((e) => (
                  <li key={e.id} className="rounded-lg border px-3 py-2 text-xs">
                    <span className="font-semibold">{e.edge_type ?? "edge"}</span>
                    <span className="opacity-70">
                      {" "}
                      · {e.reference_kind}:{e.reference_value}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Operator attestation</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Attested"
                value={row.operator_review_attested ? "Yes" : "No"}
              />
              <Field label="Attested by" value={row.operator_review_attested_by ?? "—"} />
              <Field label="Attested at" value={row.operator_review_attested_at ?? "—"} />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Money lanes</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Estimated Amazon payout"
                value={formatCaseReviewMoney(lanes.estimated_amazon_payout)}
              />
              <Field
                label="Observed reimbursement"
                value={formatCaseReviewMoney(lanes.observed_reimbursement)}
              />
              <Field
                label="Internal cost loss"
                value={formatCaseReviewMoney(lanes.internal_cost_loss)}
              />
              <Field label="Recovery value" value={formatCaseReviewMoney(lanes.recovery_value)} />
            </dl>
          </section>

          {row.rollback_metadata ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Rollback metadata</h3>
              <pre className="overflow-auto rounded-lg bg-amber-500/10 p-3 text-[10px]">
                {JSON.stringify(row.rollback_metadata, null, 2)}
              </pre>
            </section>
          ) : null}

          {row.warnings.length > 0 ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Warnings</h3>
              <ul className="list-disc pl-4 text-xs text-amber-800 dark:text-amber-200">
                {row.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <ClaimCaseReviewFilingPacketSection
            row={row}
            pilotCaseRunId={pilotCaseRunId}
            intakeRunId={intakeRunId}
            fetchJson={fetchJson}
          />

          <ClaimCaseReviewManualFilingHandoffSection
            row={row}
            pilotCaseRunId={pilotCaseRunId}
            intakeRunId={intakeRunId}
            fetchJson={fetchJson}
          />
        </div>
      </aside>
    </>
  );
}
