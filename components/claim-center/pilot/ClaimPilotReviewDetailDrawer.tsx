"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";

import type { ClaimPilotReviewRow } from "@/lib/claims/pilot/claim-pilot-review-readmodel";
import { formatPilotMoney } from "@/lib/claims/pilot/claim-pilot-review-ui-contract";

import { ClaimPilotReviewEvidencePacketSection } from "./ClaimPilotReviewEvidencePacketSection";

type Props = {
  row: ClaimPilotReviewRow | null;
  intakeRunId: string | null;
  fetchJson: <T>(path: string, extra?: Record<string, string>) => Promise<T>;
  onClose: () => void;
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

export function ClaimPilotReviewDetailDrawer({ row, intakeRunId, fetchJson, onClose }: Props) {
  if (!row) return null;

  const moneyLanes = row.metadata.money_lanes as Record<string, unknown> | undefined;

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
        aria-label="Pilot candidate detail"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Pilot candidate detail</h2>
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
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Identity</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Candidate ID" value={row.id} mono />
              <Field label="Intake run" value={row.intake_run_id ?? "—"} mono />
              <Field label="Family V3" value={row.family_key_v3 ?? "—"} />
              <Field label="Claim family" value={row.claim_family ?? "—"} />
              <Field label="Dedupe key" value={row.dedupe_key ?? "—"} mono />
              <Field label="Preview ID" value={row.preview_id ?? "—"} mono />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Source row pointers</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Source kind" value={row.source_kind ?? "—"} />
              <Field label="Source table" value={row.source_table} mono />
              <Field label="Source row ID" value={row.source_row_id} mono />
              <Field label="Source event key" value={row.source_event_key ?? "—"} mono />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Date gate</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Source event date" value={row.source_event_date ?? "—"} />
              <Field label="Effective date source" value={row.effective_date_source ?? "—"} />
              <Field label="Effective date value" value={row.effective_date_value ?? "—"} />
              <Field
                label="Date gate passed"
                value={row.date_gate_passed ? "Yes" : "No"}
              />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">TRID / reference edges</h3>
            {row.reference_edges.length === 0 ? (
              <p className="text-xs opacity-60">No reference edges.</p>
            ) : (
              <ul className="space-y-2">
                {row.reference_edges.map((e, i) => (
                  <li
                    key={`${e.reference_kind}-${e.reference_value}-${i}`}
                    className="rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/5"
                  >
                    <span className="font-semibold">{e.reference_kind}</span>
                    <span className="mx-1 opacity-40">·</span>
                    <span className="font-mono break-all">{e.reference_value}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Evidence</h3>
            <Field label="Evidence status" value={row.evidence_status ?? "—"} />
            <div className="mt-3">
              <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
                Evidence summary
              </dt>
              <dd className="mt-1 rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
                {row.evidence_summary ?? "—"}
              </dd>
            </div>
            <div className="mt-3">
              <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
                Evidence pointers ({row.evidence_pointers.length})
              </dt>
              <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/5 p-3 text-[10px] dark:bg-white/5">
                {JSON.stringify(row.evidence_pointers, null, 2)}
              </pre>
            </div>
          </section>

          {moneyLanes ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Money lanes</h3>
              <pre className="max-h-32 overflow-auto rounded-lg bg-black/5 p-3 text-[10px] dark:bg-white/5">
                {JSON.stringify(moneyLanes, null, 2)}
              </pre>
            </section>
          ) : null}

          {(row.rollback_mode || row.rollback_run_id) && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Rollback metadata</h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                <Field label="Rollback mode" value={row.rollback_mode ?? "—"} />
                <Field label="Rollback run ID" value={row.rollback_run_id ?? "—"} mono />
              </dl>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Quantities & amounts</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Expected quantity" value={row.expected_quantity ?? "—"} />
              <Field
                label="Recovery value"
                value={formatPilotMoney(row.recovery_value, row.currency)}
              />
              <Field label="COGS unit" value={formatPilotMoney(row.cogs_unit, row.currency)} />
            </dl>
          </section>

          {row.review_flags.length > 0 ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Review flags</h3>
              <div className="flex flex-wrap gap-2">
                {row.review_flags.map((f) => (
                  <span
                    key={f}
                    className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          <ClaimPilotReviewEvidencePacketSection
            candidateId={row.id}
            intakeRunId={intakeRunId ?? row.intake_run_id}
            fetchJson={fetchJson}
          />
        </div>
      </aside>
    </>
  );
}
