"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, Lock, X } from "lucide-react";

import {
  CLAIM_CENTER_DETAIL_DRAWER_CLASS,
  CLAIM_CENTER_DISABLED_BTN,
  CLAIM_CENTER_INPUT_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";
import {
  buildReferenceBlockText,
  computeFamilyAwareRecovery,
  computeFilingDecision,
  type DeepReferenceFilingSufficiency,
  type DeepReferenceSourceStatus,
  type EventReferenceRow,
  type FamilyCandidateClassification,
  type ReadyToFileCaseIdRecordingConfig,
  type ReadyToFileRow,
  type RecoveryGapMatch,
} from "@/lib/claims/filing/claim-ready-to-file-queue-ui-contract";

type Props = {
  row: ReadyToFileRow | null;
  caseIdRecording: ReadyToFileCaseIdRecordingConfig;
  onClose: () => void;
};

function money(v: number | null): string {
  return v == null ? "Unknown" : `$${v.toFixed(2)}`;
}

const SOURCE_STATUS_META: Record<DeepReferenceSourceStatus, { label: string; tone: string }> = {
  found: { label: "Found", tone: "success" },
  found_but_not_materialized: { label: "Found · not materialized", tone: "info" },
  found_weak_ambiguous: { label: "Found · weak/ambiguous", tone: "warning" },
  not_found_in_loaded_reports: { label: "Not found in loaded reports", tone: "neutral" },
  source_table_empty: { label: "Source table empty", tone: "neutral" },
  source_table_missing: { label: "Source table missing", tone: "neutral" },
};

const COVERAGE_META: Record<DeepReferenceFilingSufficiency, { label: string; tone: string }> = {
  complete: { label: "Coverage: Complete", tone: "success" },
  sufficient_for_manual_filing: { label: "Coverage: Filing sufficient", tone: "info" },
  needs_reference_review: { label: "Coverage: Needs reference review", tone: "warning" },
};

function ReferenceRows({ rows, muted }: { rows: EventReferenceRow[]; muted?: boolean }) {
  return (
    <>
      {rows.map((r, i) => (
        <tr
          key={`${r.source}-${r.reference_id}-${i}`}
          className={`border-b last:border-0 align-top ${muted ? "opacity-70" : ""}`}
        >
          <td className="px-2 py-1.5 whitespace-nowrap">{r.source_label}</td>
          <td className="px-2 py-1.5 font-mono break-all">{r.reference_id}</td>
          <td className="px-2 py-1.5">{r.event_type ?? "—"}</td>
          <td className="px-2 py-1.5 whitespace-nowrap">{r.event_date ?? "—"}</td>
          <td className="px-2 py-1.5">{r.quantity ?? "—"}</td>
          <td className="px-2 py-1.5">{r.amount == null ? "—" : `$${r.amount.toFixed(2)}`}</td>
          <td className="px-2 py-1.5 font-mono break-all opacity-70">{r.source_row_id ?? "—"}</td>
          <td className="px-2 py-1.5">{r.match_reason.join(", ")}</td>
          <td className="px-2 py-1.5">{r.confidence}</td>
        </tr>
      ))}
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">{label}</dt>
      <dd className={`mt-0.5 text-sm font-medium ${mono ? "break-all font-mono text-xs" : ""}`}>{value ?? "—"}</dd>
    </div>
  );
}

function CopyTextButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const trimmed = (value ?? "").trim();
  return (
    <button
      type="button"
      disabled={!trimmed}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(trimmed);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold opacity-80 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function MatchRow({ m }: { m: RecoveryGapMatch }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-2 py-1 text-[11px]">
      <span className="min-w-0">
        <span className="opacity-60">{m.source_label}: </span>
        <span className="font-mono">{m.reference_id}</span>
        {m.reason ? <span className="opacity-60"> · {m.reason}</span> : null}
        {m.event_date ? <span className="opacity-50"> · {m.event_date}</span> : null}
      </span>
      <span className="tabular-nums">{m.amount != null ? `$${m.amount.toFixed(2)}` : "—"}</span>
    </li>
  );
}

function CandidateClassRow({ c }: { c: FamilyCandidateClassification }) {
  return (
    <li className="rounded-md border px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0">
          <span className="opacity-60">{c.source_label}: </span>
          <span className="font-mono">{c.reference_id}</span>
          {c.reason ? <span className="opacity-60"> · {c.reason}</span> : null}
          {c.event_date ? <span className="opacity-50"> · {c.event_date}</span> : null}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={claimCenterBadgeTone(c.belongs_to_this_claim ? "neutral" : "warning")}>
            {c.classified_family}
          </span>
          <span className="tabular-nums">{c.amount != null ? `$${c.amount.toFixed(2)}` : "—"}</span>
        </span>
      </div>
      {c.why_not ? <p className="mt-1 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">{c.why_not}</p> : null}
      {c.should_create_separate_claim ? (
        <p className="mt-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
          → Suggests a separate claim opportunity ({c.classified_family}).
        </p>
      ) : null}
    </li>
  );
}

function ReimbursementRecoveryGapSection({ row }: { row: ReadyToFileRow }) {
  const fa = computeFamilyAwareRecovery(row);
  const gap = fa.gap;
  const pol = fa.policy;
  const txnRows = [...gap.settlement_credit_matches, ...gap.strong_transaction_matches].slice(0, 8);
  const ledgerRows = gap.inventory_ledger_candidates.slice(0, 6);
  const weakClasses = fa.candidate_classifications.slice(0, 10);

  return (
    <section className="rounded-xl border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase opacity-60">Recovery Gap / Claim Amount Policy</h3>
        <div className="flex items-center gap-1.5">
          {!pol.policy_resolved ? (
            <span className={claimCenterBadgeTone("warning")}>Policy needs confirmation</span>
          ) : null}
          <span className={claimCenterBadgeTone(fa.filing_status_tone)}>{fa.filing_status_label}</span>
        </div>
      </div>

      {/* Three amount rows under the configurable amount-basis policy. */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border px-2 py-1.5">
          <p className="text-[10px] uppercase opacity-55">COGS recovery</p>
          <p className="text-sm font-bold tabular-nums">{money(fa.current_cogs_expected_recovery)}</p>
        </div>
        <div className="rounded-lg border px-2 py-1.5">
          <p className="text-[10px] uppercase opacity-55">Latest sale net est.</p>
          <p className="text-sm font-bold tabular-nums">{money(fa.alternative_latest_sale_net_estimate)}</p>
        </div>
        <div className="rounded-lg border px-2 py-1.5">
          <p className="text-[10px] uppercase opacity-55">Business total loss</p>
          <p className="text-sm font-bold tabular-nums">{money(fa.business_total_loss_estimate)}</p>
        </div>
      </div>

      <div className="mt-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px]">
        <p className="font-semibold">
          Seller Central amount currently selected:{" "}
          <span className="tabular-nums">{money(fa.seller_central_amount)}</span>{" "}
          <span className="opacity-60">({fa.seller_central_amount_basis})</span>
        </p>
        <p className="mt-0.5 leading-relaxed opacity-75">{fa.seller_central_amount_reason}</p>
        <p className="mt-1 leading-relaxed opacity-60">
          Policy basis <span className="font-semibold">{pol.default_claim_amount_basis}</span> ·{" "}
          {pol.amount_kind === "amazon_claim_amount"
            ? "Amazon claim amount"
            : pol.amount_kind === "internal_business_loss"
              ? "internal business loss"
              : "configurable"}{" "}
          · sale price {pol.sale_price_allowed ? "allowed" : "not allowed"} · fees{" "}
          {pol.amazon_fees_included ? "included" : "excluded"} · inbound/removal/handling{" "}
          {pol.inbound_removal_handling_included ? "included" : "excluded"}.
        </p>
        {!pol.policy_resolved ? (
          <p className="mt-1 leading-relaxed text-amber-700 dark:text-amber-300">
            Recommended: {pol.recommended_correction}
          </p>
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border px-2 py-1.5">
          <p className="text-[10px] uppercase opacity-55">Confirmed (strong)</p>
          <p className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
            {fa.confirmed_reimbursed_strong > 0 ? money(fa.confirmed_reimbursed_strong) : "—"}
          </p>
        </div>
        <div className="rounded-lg border px-2 py-1.5">
          <p className="text-[10px] uppercase opacity-55">Open gap (current)</p>
          <p className="text-sm font-bold tabular-nums text-amber-700 dark:text-amber-300">
            {money(fa.open_gap_under_current_policy)}
          </p>
        </div>
        <div className="rounded-lg border px-2 py-1.5">
          <p className="text-[10px] uppercase opacity-55">Open gap (alt)</p>
          <p className="text-sm font-bold tabular-nums opacity-80">{money(fa.open_gap_under_alternative_policy)}</p>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed opacity-80">{gap.match_reason}</p>
      <p className="mt-1 text-[10px] uppercase tracking-wide opacity-55">
        Match confidence: <span className="font-semibold">{gap.match_confidence}</span> · Filing status:{" "}
        <span className="font-semibold">{fa.filing_status}</span>
      </p>

      {fa.separate_claim_suggestions.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="text-[11px] font-bold text-amber-950 dark:text-amber-100">
            Separate claim opportunities suggested ({fa.separate_claim_suggestions.length})
          </p>
          <ul className="mt-1 space-y-1">
            {fa.separate_claim_suggestions.map((s, i) => (
              <li key={`sep-${i}`} className="text-[11px] text-amber-950/90 dark:text-amber-100/90">
                <span className="font-semibold">{s.recommended_claim_family}</span>{" "}
                <span className="opacity-70">({s.basis})</span> · {s.candidate_count} candidate(s) ·{" "}
                {s.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {gap.strong_reimbursement_matches.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            Strong reimbursement matches (counted)
          </p>
          <ul className="space-y-1">
            {gap.strong_reimbursement_matches.map((m, i) => (
              <MatchRow key={`sr-${i}`} m={m} />
            ))}
          </ul>
        </div>
      ) : null}

      {gap.settlement_credit_matches.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            Settlement credit matches (counted)
          </p>
          <ul className="space-y-1">
            {gap.settlement_credit_matches.map((m, i) => (
              <MatchRow key={`sc-${i}`} m={m} />
            ))}
          </ul>
        </div>
      ) : null}

      {weakClasses.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Weak candidates — family-aware (excluded from claim amount)
          </p>
          <ul className="space-y-1">
            {weakClasses.map((c, i) => (
              <CandidateClassRow key={`wc-${i}`} c={c} />
            ))}
          </ul>
        </div>
      ) : null}

      {txnRows.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-60">
            Transaction / settlement candidates
          </p>
          <ul className="space-y-1">
            {txnRows.map((m, i) => (
              <MatchRow key={`tx-${i}`} m={m} />
            ))}
          </ul>
        </div>
      ) : null}

      {ledgerRows.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-60">
            Inventory-ledger candidates (advisory)
          </p>
          <ul className="space-y-1">
            {ledgerRows.map((m, i) => (
              <MatchRow key={`il-${i}`} m={m} />
            ))}
          </ul>
        </div>
      ) : null}

      {gap.excluded_candidates_and_reason.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-semibold opacity-70">Why candidates were excluded</summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[11px] opacity-80">
            {gap.excluded_candidates_and_reason.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {gap.files_checked.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold opacity-70">
            Exact files / sources checked ({gap.files_checked.length})
          </summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[11px] opacity-80">
            {gap.files_checked.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {gap.missing_files_or_api.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="text-[11px] font-bold text-amber-950 dark:text-amber-100">
            Missing files / API to confirm reimbursement
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-amber-950/90 dark:text-amber-100/90">
            {gap.missing_files_or_api.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function ReadyToFileDetailDrawer({ row, caseIdRecording, onClose }: Props) {
  const [filedManually, setFiledManually] = useState(false);

  if (!row) return null;

  const m = row.money_lane;
  const rh = row.reference_health;
  const led = row.event_reference_ledger;
  const referenceBlock = buildReferenceBlockText(row);
  const decision = computeFilingDecision(row);

  const confidenceTone =
    led.confidence === "high" ? "success" : led.confidence === "medium" ? "neutral" : "warning";

  return (
    <>
      <div className="fixed inset-0 z-[490] bg-black/40" onClick={onClose} aria-hidden />
      <aside className={`${CLAIM_CENTER_DETAIL_DRAWER_CLASS} claim-center-card flex flex-col`}>
        <header className="flex items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold">Filing packet</h2>
              {row.ready_to_file ? (
                <span className={claimCenterBadgeTone("success")}>Ready to file</span>
              ) : row.filing_status === "needs_reference_review" ? (
                <span className={claimCenterBadgeTone("warning")}>Needs reference review</span>
              ) : (
                <span className={claimCenterBadgeTone("warning")}>Blocked</span>
              )}
              <span className={claimCenterBadgeTone("neutral")}>{row.claim_family ?? "—"}</span>
            </div>
            <p className="mt-1 font-mono text-[11px] opacity-60">{row.claim_submission_id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border opacity-70 hover:opacity-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-950 dark:text-sky-100">
            MENORIX does not submit anything to Amazon. This packet is for manual Seller Central filing only.
          </p>

          {/* ---- Filing Decision ---- */}
          <section className="rounded-xl border p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase opacity-60">Filing Decision</h3>
              <span className={claimCenterBadgeTone(decision.tone)}>{decision.label}</span>
            </div>
            <p className="text-[11px] leading-relaxed opacity-80">{decision.reason}</p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
                  High-confidence references used
                </p>
                {decision.high_confidence_refs.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {decision.high_confidence_refs.map((r, i) => (
                      <li key={i} className="break-all font-mono text-[11px]">
                        ✓ {r}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[11px] opacity-60">None — no strong external reference.</p>
                )}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
                  Weak references excluded
                </p>
                {decision.weak_refs_excluded.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {decision.weak_refs_excluded.map((r, i) => (
                      <li key={i} className="text-[11px] opacity-70">
                        ✗ {r}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[11px] opacity-60">None.</p>
                )}
              </div>
            </div>

            {decision.internal_anchors_excluded.length > 0 ? (
              <p className="mt-2 text-[10px] opacity-55">
                Internal anchors excluded from Seller Central text:{" "}
                {decision.internal_anchors_excluded.join(", ")}
              </p>
            ) : null}

            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] font-semibold opacity-70">
                Human review checklist
              </summary>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[11px] opacity-80">
                {decision.human_review_checklist.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </details>

            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
                  Final copy block (external references only)
                </p>
                <CopyTextButton value={referenceBlock} label="Copy reference block" />
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border bg-black/[0.03] p-2.5 text-[11px] dark:bg-white/[0.04]">
                {referenceBlock}
              </pre>
            </div>
          </section>

          {/* ---- Reimbursement / Recovery Gap ---- */}
          <ReimbursementRecoveryGapSection row={row} />

          {/* ---- Claim summary ---- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Claim summary</h3>
            <dl className="grid grid-cols-2 gap-3">
              <Field label="Claim case ID" value={row.claim_case_id} mono />
              <Field label="Family" value={row.claim_family} />
              <Field label="Filing status" value={row.filing_status} />
              <Field label="Clean quantity" value={row.clean_quantity ?? "—"} />
            </dl>
            <div className="mt-3 rounded-lg border bg-black/[0.02] px-3 py-2 text-xs dark:bg-white/[0.03]">
              <span className="font-semibold">Recovery formula: </span>
              {row.recovery_formula}
            </div>
          </section>

          {/* ---- Money lane ---- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Money lane</h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Latest sold price" value={money(m.latest_sold_price)} />
              <Field label="Amazon fees" value={money(m.amazon_fees_total)} />
              <Field label="Settlement net" value={money(m.net_settlement_amount)} />
              <Field label="COGS / unit" value={money(m.approved_cogs_unit)} />
              <Field
                label="Recovery value"
                value={<span className="font-bold text-emerald-700 dark:text-emerald-300">{money(m.recovery_value)}</span>}
              />
              <Field
                label="Observed reimbursement"
                value={
                  <span className="text-amber-700 dark:text-amber-300">{m.observed_reimbursement_status}</span>
                }
              />
            </dl>
            <p className="mt-2 text-[10px] opacity-60">
              Sale price is informational only — the claim amount uses approved COGS.
            </p>
          </section>

          {/* ---- Product references ---- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Product references</h3>
            <dl className="grid grid-cols-2 gap-3">
              <Field label="FNSKU" value={row.fnsku} mono />
              <Field label="SKU" value={row.sku} mono />
              <Field label="ASIN" value={row.asin} mono />
              <Field label="resolved_product_id" value={row.product_identity.resolved_product_id} mono />
            </dl>
          </section>

          {/* ---- Primary reference anchor ---- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Primary reference anchor</h3>
            <dl className="grid grid-cols-2 gap-3">
              <Field label={led.primary_reference_anchor.label} value={led.primary_reference_anchor.value} mono />
              <Field
                label="Reference type"
                value={
                  <span className="flex items-center gap-1.5">
                    {led.primary_reference_anchor.is_external_amazon_reference ? (
                      <span className={claimCenterBadgeTone("success")}>External Amazon reference</span>
                    ) : (
                      <span className={claimCenterBadgeTone("warning")}>Internal anchor only</span>
                    )}
                    <span className={claimCenterBadgeTone(confidenceTone)}>conf: {led.confidence}</span>
                  </span>
                }
              />
              <Field label="External references" value={led.external_reference_count} />
              <Field label="Internal anchors" value={led.internal_anchor_count} />
            </dl>
            {led.needs_reference_review ? (
              <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-[10px] font-semibold text-amber-950 dark:text-amber-100">
                Needs reference review — no real external Amazon report/event reference resolved. Do not file with
                internal IDs only.
              </p>
            ) : null}
            <p className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-950 dark:text-amber-100">
              Event date/time used as a match filter:{" "}
              <strong>{led.event_time_window_used ? "yes" : "no"}</strong>. {led.event_datetime_note}
            </p>
          </section>

          {/* ---- Event / Transaction References (deep, by source group) ---- */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase opacity-60">Event / Transaction References</h3>
              <span className={claimCenterBadgeTone(COVERAGE_META[led.filing_sufficiency].tone)}>
                {COVERAGE_META[led.filing_sufficiency].label}
              </span>
            </div>
            <p className="mb-2 text-[10px] opacity-60">
              Deep search across every loaded Amazon report/source table. Materialized rows are real external
              references; window candidates (FNSKU/SKU ± {led.date_window_days}d around the event) are advisory only
              and excluded from the Seller Central block. Internal DB UUIDs are kept under Internal anchors below.
            </p>
            <div className="mb-2 flex flex-wrap gap-1.5 text-[10px]">
              <span className="rounded-md border px-2 py-0.5 opacity-70">
                Matched by: {led.matched_by.length ? led.matched_by.join(", ") : "—"}
              </span>
              <span className="rounded-md border px-2 py-0.5 opacity-70">
                Event-date window used: <strong>{led.date_window_used ? "yes" : "no"}</strong> · candidates:{" "}
                {led.date_window_candidate_count}
              </span>
            </div>

            <div className="space-y-2">
              {led.source_groups.map((g) => {
                const meta = SOURCE_STATUS_META[g.status];
                const hasRows = g.references.length > 0 || g.candidate_samples.length > 0;
                return (
                  <div key={g.group} className="rounded-lg border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-black/[0.03] px-2.5 py-1.5 dark:bg-white/[0.04]">
                      <span className="text-[11px] font-semibold">{g.source_label}</span>
                      <span className={claimCenterBadgeTone(meta.tone)}>{meta.label}</span>
                    </div>
                    {hasRows ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-[11px]">
                          <thead className="border-b">
                            <tr>
                              <th className="px-2 py-1 font-semibold">Source</th>
                              <th className="px-2 py-1 font-semibold">Reference / Transaction ID</th>
                              <th className="px-2 py-1 font-semibold">Event Type</th>
                              <th className="px-2 py-1 font-semibold">Event Date</th>
                              <th className="px-2 py-1 font-semibold">Qty</th>
                              <th className="px-2 py-1 font-semibold">Amount</th>
                              <th className="px-2 py-1 font-semibold">Source Row</th>
                              <th className="px-2 py-1 font-semibold">Match Reason</th>
                              <th className="px-2 py-1 font-semibold">Conf.</th>
                            </tr>
                          </thead>
                          <tbody>
                            <ReferenceRows rows={g.references} />
                            <ReferenceRows rows={g.candidate_samples} muted />
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    <p className="px-2.5 py-1.5 text-[10px] opacity-60">{g.note}</p>
                  </div>
                );
              })}
              {led.source_groups.length === 0 ? (
                <p className="rounded-lg border px-3 py-3 text-center text-[11px] opacity-60">
                  No source groups — needs reference review.
                </p>
              ) : null}
            </div>

            {/* Not found / not applicable summary */}
            {led.not_found_sources.length > 0 || led.ambiguous_sources.length > 0 ? (
              <div className="mt-2 rounded-lg border border-dashed p-2.5 text-[10px]">
                {led.not_found_sources.length > 0 ? (
                  <p>
                    <strong className="opacity-70">Not found / not applicable:</strong>{" "}
                    {led.not_found_sources.join("; ")}
                  </p>
                ) : null}
                {led.ambiguous_sources.length > 0 ? (
                  <p className="mt-1">
                    <strong className="opacity-70">Found but weak/ambiguous (advisory):</strong>{" "}
                    {led.ambiguous_sources.join("; ")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* ---- Internal anchors (collapsed debug) ---- */}
          <section>
            <details className="rounded-lg border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase opacity-60">
                Internal anchors (debug — not Amazon proof)
              </summary>
              <div className="space-y-3 border-t p-3">
                <dl className="grid grid-cols-1 gap-2">
                  {led.internal_anchors.map((a, i) => (
                    <div key={`${a.kind}-${a.value}-${i}`} className="min-w-0">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
                        {a.label} <span className="opacity-50">({a.kind})</span>
                      </dt>
                      <dd className="mt-0.5 break-all font-mono text-xs">{a.value}</dd>
                      <dd className="text-[10px] opacity-55">{a.note}</dd>
                    </div>
                  ))}
                  {led.internal_anchors.length === 0 ? (
                    <p className="text-xs opacity-60">No internal anchors.</p>
                  ) : null}
                </dl>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-left text-[11px]">
                    <thead className="border-b bg-black/[0.03] dark:bg-white/[0.04]">
                      <tr>
                        <th className="px-2 py-1.5 font-semibold">Kind</th>
                        <th className="px-2 py-1.5 font-semibold">Value</th>
                        <th className="px-2 py-1.5 font-semibold">Source table</th>
                        <th className="px-2 py-1.5 font-semibold">Source row</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rh.edges.map((e) => (
                        <tr key={e.id} className="border-b last:border-0">
                          <td className="px-2 py-1.5">{e.reference_kind ?? "—"}</td>
                          <td className="px-2 py-1.5 font-mono break-all">{e.reference_value ?? "—"}</td>
                          <td className="px-2 py-1.5">{e.source_table ?? "—"}</td>
                          <td className="px-2 py-1.5 font-mono break-all opacity-70">{e.source_row_id ?? "—"}</td>
                        </tr>
                      ))}
                      {rh.edges.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-2 py-3 text-center opacity-60">
                            No reference edges materialized.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          </section>

          {/* ---- Evidence / attachments ---- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Evidence packet / attachments</h3>
            <p className="break-all rounded-md border bg-black/[0.02] px-3 py-2 font-mono text-[10px] dark:bg-white/[0.03]">
              {row.packet.evidence_packet_path}
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {row.packet.attachments_to_include.map((a, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="mt-0.5 opacity-50">•</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ---- Human review checklist ---- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-60">Human review checklist</h3>
            <ul className="space-y-1.5 text-xs">
              {row.packet.human_review_checklist.map((c, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-50" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ---- Seller Central copy section ---- */}
          <section className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase opacity-70">Seller Central copy</h3>
            <div className="space-y-3">
              <div>
                <p className="text-[10px] font-semibold uppercase opacity-55">Case subject</p>
                <p className="mt-1 rounded-md border bg-white/60 px-2 py-1.5 text-xs dark:bg-black/20">
                  {row.packet.seller_central_case_subject}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase opacity-55">Case message body</p>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-white/60 px-2 py-1.5 text-[11px] dark:bg-black/20">
                  {row.packet.seller_central_message_body}
                </pre>
              </div>
              <dl className="grid grid-cols-2 gap-3">
                <Field label="Requested reimbursement" value={money(row.recovery_value)} />
                <Field label="Affected quantity" value={row.clean_quantity ?? "—"} />
              </dl>
              <div>
                <p className="text-[10px] font-semibold uppercase opacity-55">
                  References to include in Seller Central
                </p>
                <p className="mb-1 text-[10px] opacity-55">
                  Real external/source references only — no internal DB UUIDs.
                </p>
                <pre className="mt-1 whitespace-pre-wrap rounded-md border bg-white/60 px-2 py-1.5 text-[11px] dark:bg-black/20">
                  {referenceBlock}
                </pre>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase opacity-55">Attachment checklist</p>
                <ul className="mt-1 space-y-1 text-[11px]">
                  {row.packet.attachments_to_include.map((a, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="mt-0.5 opacity-50">☐</span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-wrap gap-2">
                <CopyTextButton value={row.packet.seller_central_case_subject} label="Copy subject" />
                <CopyTextButton value={row.packet.seller_central_message_body} label="Copy message" />
                <CopyTextButton value={referenceBlock} label="Copy reference block" />
                <a
                  href={`file:///${row.packet.evidence_packet_path}`}
                  onClick={(e) => e.preventDefault()}
                  title={row.packet.evidence_packet_path}
                  className="inline-flex cursor-default items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold opacity-70"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open evidence packet
                </a>
              </div>
            </div>
          </section>

          {/* ---- Case ID recording (guarded, disabled by default) ---- */}
          <section className="rounded-xl border p-3">
            <div className="mb-2 flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 opacity-60" />
              <h3 className="text-xs font-semibold uppercase opacity-70">Record Amazon Case ID</h3>
            </div>
            <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-950 dark:text-amber-100">
              This section does not submit to Amazon. Save/recording will be enabled by the governed manual
              filing status phase ({caseIdRecording.write_phase_required}).
            </p>
            <label className="mb-3 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={filedManually}
                onChange={(e) => setFiledManually(e.target.checked)}
              />
              {caseIdRecording.unlock_label}
            </label>
            <fieldset disabled={!filedManually} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {caseIdRecording.fields.map((f) => (
                <label key={f.key} className="text-xs">
                  <span className="mb-0.5 block opacity-60">
                    {f.label}
                    {f.required ? " *" : ""}
                  </span>
                  <input
                    className={`${CLAIM_CENTER_INPUT_CLASS} disabled:opacity-50`}
                    placeholder={f.key}
                    disabled={!filedManually}
                  />
                </label>
              ))}
            </fieldset>
            <button type="button" disabled className={`${CLAIM_CENTER_DISABLED_BTN} mt-3 rounded-lg border px-3 py-2 text-xs font-semibold`}>
              Save (disabled — guarded write)
            </button>
          </section>

          {/* ---- Blockers (if any) ---- */}
          {row.blockers.length > 0 ? (
            <section className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-red-800 dark:text-red-200">
                <AlertTriangle className="h-3.5 w-3.5" /> Blockers
              </h3>
              <ul className="space-y-1 text-xs">
                {row.blockers.map((b) => (
                  <li key={b} className="font-mono">
                    {b}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </aside>
    </>
  );
}
