"use client";

import { useCallback, useState, type ReactNode } from "react";
import { AlertTriangle, Briefcase, CheckCircle2, Eye, Loader2, ShieldAlert } from "lucide-react";

import type {
  ClaimCaseCreationPreviewV1Payload,
  ClaimCasePreviewV1,
} from "@/lib/claims/case-creation/claim-case-creation-preview-v1";
import {
  CASE_CREATION_PREVIEW_API_PATH,
  CASE_PREVIEW_BUTTON_LABEL,
  CASE_PREVIEW_RECOMMENDED_ACTION_LABELS,
  CASE_PREVIEW_SECTION_ID,
  EVIDENCE_PACKET_SECTION_ID,
  casePreviewApiParams,
  deriveCasePreviewActionTone,
  productIdentifiersLabel,
} from "@/lib/claims/pilot/claim-case-creation-preview-ui-contract";
import { formatPilotMoney } from "@/lib/claims/pilot/claim-pilot-review-ui-contract";
import { claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";

type Props = {
  candidateId: string;
  intakeRunId: string | null;
  fetchJson: <T>(path: string, extra?: Record<string, string>) => Promise<T>;
};

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words">{value}</dd>
    </div>
  );
}

function actionBadgeClass(tone: ReturnType<typeof deriveCasePreviewActionTone>): string {
  if (tone === "success") return "bg-emerald-500/15 text-emerald-900 dark:text-emerald-100 border-emerald-500/30";
  if (tone === "warning") return "bg-amber-500/15 text-amber-900 dark:text-amber-100 border-amber-500/30";
  return "bg-red-500/15 text-red-900 dark:text-red-100 border-red-500/30";
}

function ActionIcon({ action }: { action: ClaimCasePreviewV1["recommended_action"] }) {
  if (action === "create_case_preview_ready") return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />;
  if (action === "needs_operator_review") return <AlertTriangle className="h-3.5 w-3.5" aria-hidden />;
  return <ShieldAlert className="h-3.5 w-3.5" aria-hidden />;
}

function CasePreviewContent({ preview }: { preview: ClaimCasePreviewV1 }) {
  const tone = deriveCasePreviewActionTone(preview.recommended_action);

  return (
    <div className="space-y-4">
      <div
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${actionBadgeClass(tone)}`}
      >
        <ActionIcon action={preview.recommended_action} />
        {CASE_PREVIEW_RECOMMENDED_ACTION_LABELS[preview.recommended_action]}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Case preview ID" value={<span className="font-mono text-xs break-all">{preview.case_preview_id}</span>} />
        <Field label="Proposed case type" value={preview.proposed_case_type} />
        <Field label="Proposed case family" value={preview.proposed_case_family} />
        <Field label="Family V3" value={preview.family_key_v3 ?? "—"} />
        <Field label="Claim family" value={preview.claim_family ?? "—"} />
        <Field label="Source kind" value={preview.source_kind ?? "—"} />
        <Field
          label="Source event key"
          value={<span className="font-mono text-xs break-all">{preview.source_event_key ?? "—"}</span>}
        />
        <Field label="Grouping mode" value={preview.grouping_mode} />
      </dl>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Included candidates</h4>
        <ul className="space-y-1">
          {preview.included_candidate_ids.map((id) => (
            <li key={id} className="font-mono text-[10px] break-all rounded bg-black/5 px-2 py-1 dark:bg-white/5">
              {id}
            </li>
          ))}
        </ul>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Product" value={productIdentifiersLabel(preview.product_identifiers)} />
        <Field label="Linkage" value={preview.product_identifiers.linkage_status} />
        <Field label="Clean quantity" value={preview.clean_quantity ?? "—"} />
        <Field label="Estimated amount" value={formatPilotMoney(preview.estimated_amount, null)} />
        <Field label="Recovery value" value={formatPilotMoney(preview.recovery_value, null)} />
        <Field
          label="Observed reimbursement"
          value={formatPilotMoney(preview.observed_reimbursement, null)}
        />
      </dl>

      <Field
        label="Evidence readiness"
        value={
          <span className={claimCenterBadgeTone(preview.evidence_packet_readiness.ready_for_case_creation === "yes" ? "success" : "warning")}>
            {preview.evidence_packet_readiness.ready_for_case_creation === "yes" ? "Ready" : "Not ready"}
          </span>
        }
      />

      {preview.money_warnings.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Money warnings</h4>
          <div className="flex flex-wrap gap-2">
            {preview.money_warnings.map((w) => (
              <span
                key={w}
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200"
              >
                {w}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {preview.warnings.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Warnings</h4>
          <div className="flex flex-wrap gap-2">
            {preview.warnings.map((w) => (
              <span
                key={w}
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200"
              >
                {w}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {preview.blockers.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Blockers</h4>
          <div className="flex flex-wrap gap-2">
            {preview.blockers.map((b) => (
              <span
                key={b}
                className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-800 dark:text-red-200"
              >
                {b}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Duplicate risk</h4>
        {preview.duplicate_risk.has_risk ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs">
            <p className="font-semibold text-red-800 dark:text-red-200">Duplicate risk detected</p>
            <p className="mt-1 opacity-80">{preview.duplicate_risk.reasons.join(", ")}</p>
            {preview.duplicate_risk.existing_case_id ? (
              <p className="mt-1 font-mono text-[10px]">Existing case: {preview.duplicate_risk.existing_case_id}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs opacity-70">No active case collision for this idempotency key.</p>
        )}
      </div>

      <Field
        label="Case idempotency key"
        value={<span className="font-mono text-[10px] break-all">{preview.case_idempotency_key}</span>}
      />
    </div>
  );
}

export function ClaimPilotReviewCasePreviewSection({ candidateId, intakeRunId, fetchJson }: Props) {
  const [preview, setPreview] = useState<ClaimCasePreviewV1 | null>(null);
  const [evaluation, setEvaluation] = useState<ClaimCaseCreationPreviewV1Payload["evaluations"][0] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);

  const loadPreview = useCallback(async () => {
    if (!candidateId) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    setEvaluation(null);
    setOpened(true);
    try {
      const data = await fetchJson<ClaimCaseCreationPreviewV1Payload>(
        CASE_CREATION_PREVIEW_API_PATH,
        casePreviewApiParams({ candidateId, intakeRunId, limit: 1 }),
      );
      const ev = data.evaluations.find((e) => e.candidate_id === candidateId) ?? data.evaluations[0] ?? null;
      setEvaluation(ev);
      setPreview(ev?.case_preview ?? data.case_previews[0] ?? null);
      if (!ev?.case_preview && ev?.recommended_action === "blocked") {
        setError("Candidate is blocked from case creation preview.");
      } else if (!ev?.case_preview) {
        setError("No case preview composed for this candidate.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load case preview.");
    } finally {
      setLoading(false);
    }
  }, [candidateId, intakeRunId, fetchJson]);

  const scrollToEvidence = () => {
    document.getElementById(EVIDENCE_PACKET_SECTION_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section
      id={CASE_PREVIEW_SECTION_ID}
      className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase opacity-70">Case creation preview</h3>
        <span className="text-[10px] opacity-50">read-only · no INSERT</span>
      </div>
      <p className="mb-4 text-[11px] opacity-70">
        Dry-run via <code className="text-[10px]">{CASE_CREATION_PREVIEW_API_PATH}</code>. Shows what{" "}
        <code className="text-[10px]">claim_cases</code> would look like — no writes.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void loadPreview()}
          disabled={loading}
          className="claim-center-btn inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Briefcase className="h-4 w-4" aria-hidden />
          )}
          {CASE_PREVIEW_BUTTON_LABEL}
        </button>
        <button
          type="button"
          onClick={scrollToEvidence}
          className="claim-center-btn inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold opacity-80"
        >
          <Eye className="h-4 w-4" aria-hidden />
          View evidence packet
        </button>
      </div>

      {!opened && !loading ? (
        <p className="mt-3 text-xs opacity-60">
          Tap Preview case creation to load proposed case fields for this candidate.
        </p>
      ) : null}

      {loading ? (
        <div className="mt-4 flex items-center gap-2 py-4 text-xs opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading case preview…
        </div>
      ) : error && !preview ? (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-4 text-xs">
          <p className="font-semibold text-red-800 dark:text-red-200">Could not load case preview</p>
          <p className="mt-1 opacity-80">{error}</p>
          {evaluation ? (
            <p className="mt-2 opacity-70">
              Recommended action: {CASE_PREVIEW_RECOMMENDED_ACTION_LABELS[evaluation.recommended_action]}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void loadPreview()}
            className="mt-3 rounded-lg border px-2 py-1 text-[10px] font-semibold opacity-80 hover:opacity-100"
          >
            Retry
          </button>
        </div>
      ) : preview ? (
        <div className="mt-4">
          <CasePreviewContent preview={preview} />
        </div>
      ) : opened ? (
        <p className="mt-4 text-xs opacity-60">No case preview available for this candidate.</p>
      ) : null}
    </section>
  );
}
