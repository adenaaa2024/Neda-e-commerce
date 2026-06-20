"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, X } from "lucide-react";

import { CLAIM_CENTER_DETAIL_DRAWER_CLASS, claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";
import type { SeparateFamilyCandidatePreview } from "@/lib/claims/opportunities/separate-family-candidate-generator-contract-v1";

function money(v: number | null | undefined): string {
  return v == null ? "—" : `$${v.toFixed(2)}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">{label}</dt>
      <dd className={`mt-0.5 text-sm font-medium ${mono ? "break-all font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

/**
 * Clean candidate drawer — the 7-block opportunity layout:
 * Summary · Why this exists · Financial amount · Evidence/references · Blockers ·
 * Product Story link · Next action. Read-only; opens no Amazon submission.
 */
export function SeparateFamilyCandidateDrawer({
  candidate,
  approved,
  onClose,
}: {
  candidate: SeparateFamilyCandidatePreview | null;
  approved: boolean;
  onClose: () => void;
}) {
  if (!candidate) return null;

  const product = candidate.product_identity;
  const productId = product.fnsku ?? product.sku ?? product.asin ?? null;
  const productStoryHref = productId
    ? `/claim-center/references?q=${encodeURIComponent(productId)}`
    : "/claim-center/references";

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[490] bg-black/40"
        aria-label="Close candidate detail"
        onClick={onClose}
      />
      <aside className={`${CLAIM_CENTER_DETAIL_DRAWER_CLASS} flex flex-col`} role="dialog" aria-label="Candidate detail">
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide opacity-60">Claim opportunity</p>
            <h2 className="truncate text-lg font-bold">{candidate.family_display_name}</h2>
            <p className="font-mono text-[10px] opacity-55">{candidate.recommended_claim_family}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 opacity-70 hover:opacity-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4 text-sm">
          {/* 1 — Summary */}
          <Section title="Summary">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Family" value={candidate.family_display_name} />
              <Field
                label="Confidence"
                value={
                  <span className={claimCenterBadgeTone(candidate.confidence === "medium" ? "info" : "neutral")}>
                    {candidate.confidence}
                  </span>
                }
              />
              <Field label="Product" value={productId ?? "—"} mono />
              <Field label="Quantity" value={candidate.quantity ?? "—"} />
              <Field label="Event date" value={candidate.event_date ? candidate.event_date.slice(0, 10) : "—"} />
              <Field label="Source" value={candidate.source_table ?? "—"} mono />
            </dl>
          </Section>

          {/* 2 — Why this exists */}
          <Section title="Why this exists">
            <p className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs leading-relaxed opacity-90">
              {candidate.event_type_reason ?? "Potential recoverable event detected from the source row above."}
            </p>
            <p className="mt-2 rounded-md bg-black/[0.03] px-2.5 py-1.5 text-[11px] leading-snug opacity-75 dark:bg-white/[0.04]">
              {candidate.separate_from_removal_reason}
            </p>
          </Section>

          {/* 3 — Financial amount */}
          <Section title="Financial amount">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Amount basis" value={candidate.claim_amount_basis} />
              <Field label="Observed amount" value={money(candidate.amount)} />
              <Field label="Expected claim" value={<span className="font-bold">{money(candidate.expected_claim_amount)}</span>} />
              <Field label="Reimbursement" value={candidate.reimbursement_matching_status.replace(/_/g, " ")} />
            </dl>
          </Section>

          {/* 4 — Evidence / references */}
          <Section title="Evidence / references">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Source row" value={candidate.source_row_id ?? "—"} mono />
              <Field label="Source group" value={candidate.source_group} />
            </dl>
            {candidate.matched_references.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {candidate.matched_references.map((r) => (
                  <li key={r} className="rounded-md border px-2.5 py-1 font-mono text-[10px] break-all">
                    {r}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs opacity-60">No external references matched yet.</p>
            )}
          </Section>

          {/* 5 — Blockers */}
          <Section title="Blockers">
            {candidate.blockers.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {candidate.blockers.map((b) => (
                  <span key={b} className={claimCenterBadgeTone("danger")} title={b}>
                    {b.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                Writeable — no blockers.
              </p>
            )}
          </Section>

          {/* 6 — Product Story link */}
          <Section title="Product Story">
            <Link
              href={productStoryHref}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
            >
              Open Product Story <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </Section>

          {/* 7 — Next action */}
          <Section title="Next action">
            {candidate.blockers.length > 0 ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
                Resolve the blocker(s) above before this opportunity can be promoted to a claim candidate.
              </p>
            ) : approved ? (
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs leading-relaxed">
                Ready to promote to a claim candidate (write approved). Promotion happens in the governed pipeline —
                Claim Center never submits to Amazon.
              </p>
            ) : (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
                Preview only — promotion to a claim candidate requires operator write approval. No writes occur here.
              </p>
            )}
          </Section>
        </div>
      </aside>
    </>
  );
}
