"use client";

import { useCallback, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  HandHelping,
  Loader2,
  Lock,
  ShieldAlert,
} from "lucide-react";

import type { ClaimCaseReviewRow } from "@/lib/claims/pilot/claim-case-review-readmodel";
import type {
  ClaimFilingPacketPreviewPayload,
  ClaimFilingPacketPreviewV1,
} from "@/lib/claims/filing/claim-filing-packet-preview-v1";
import { FILING_PACKET_API_PATH } from "@/lib/claims/filing/claim-filing-packet-ui-contract";
import { formatCaseReviewMoney } from "@/lib/claims/pilot/claim-case-review-ui-contract";
import {
  remediationStatusLabel,
  isRemediatedDuplicateCase,
} from "@/lib/claims/filing/claim-filing-packet-ui-contract";
import type { ManualFilingReadinessState } from "@/lib/claims/submission/claim-submission-manual-filing-contract-v1";
import {
  buildDraftArtifactPaths,
  buildHandoffReferenceGraph,
  deriveHandoffReadinessState,
  HANDOFF_READINESS_BADGE_LABELS,
  MANUAL_FILING_HANDOFF_BUTTON_LABEL,
  MANUAL_FILING_HANDOFF_CHECKLIST_ITEMS,
  MANUAL_FILING_HANDOFF_DISABLED_ACTIONS,
  MANUAL_FILING_HANDOFF_SECTION_ID,
  manualFilingHandoffDisabled,
  moneyWarningLabels,
  NOT_SUBMITTED_BANNER_TEXT,
  handoffApiParams,
} from "@/lib/claims/submission/claim-manual-filing-handoff-ui-contract";

type Props = {
  row: ClaimCaseReviewRow;
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

function readinessBadgeStyles(state: ManualFilingReadinessState): string {
  switch (state) {
    case "ready_for_manual_filing":
      return "bg-emerald-500/15 text-emerald-900 dark:text-emerald-100 border-emerald-500/30";
    case "needs_review":
      return "bg-amber-500/15 text-amber-900 dark:text-amber-100 border-amber-500/30";
    case "already_submitted":
      return "bg-sky-500/15 text-sky-900 dark:text-sky-100 border-sky-500/30";
    case "duplicate_submission_risk":
      return "bg-orange-500/15 text-orange-900 dark:text-orange-100 border-orange-500/30";
    case "blocked":
    default:
      return "bg-red-500/15 text-red-900 dark:text-red-100 border-red-500/30";
  }
}

function ReadinessIcon({ state }: { state: ManualFilingReadinessState }) {
  if (state === "ready_for_manual_filing") {
    return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />;
  }
  if (state === "needs_review") return <AlertTriangle className="h-3.5 w-3.5" aria-hidden />;
  return <ShieldAlert className="h-3.5 w-3.5" aria-hidden />;
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard unavailable");
}

function HandoffContent({
  preview,
  row,
  rowRemediated,
}: {
  preview: ClaimFilingPacketPreviewV1;
  row: ClaimCaseReviewRow;
  rowRemediated: boolean;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const readiness = deriveHandoffReadinessState(row, preview);
  const refGraph = buildHandoffReferenceGraph(row, preview);
  const artifacts = buildDraftArtifactPaths({
    claimCaseId: preview.claim_case_id,
    familyKeyV3: preview.family_key_v3,
    sourceEventKey: preview.source_event_key,
  });
  const moneyWarnings = moneyWarningLabels(preview);
  const identity = preview.product_identity;

  const handleCopy = async (label: string, text: string) => {
    try {
      await copyText(text);
      setCopyMsg(`${label} copied`);
      setTimeout(() => setCopyMsg(null), 2000);
    } catch {
      setCopyMsg(`Could not copy ${label}`);
    }
  };

  const copyBundle = [
    preview.source_event_key,
    refGraph.trid_reference,
    refGraph.tracking_reference,
    ...refGraph.lines.map((l) => `${l.kind}:${l.value}`),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="space-y-4">
      <div
        className="rounded-lg border-2 border-red-500/50 bg-red-500/10 px-3 py-2 text-center text-xs font-bold uppercase tracking-wide text-red-900 dark:text-red-100"
        role="status"
      >
        {NOT_SUBMITTED_BANNER_TEXT}
      </div>

      <div className="flex flex-wrap gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${readinessBadgeStyles(readiness)}`}
        >
          <ReadinessIcon state={readiness} />
          {HANDOFF_READINESS_BADGE_LABELS[readiness]}
        </span>
        {refGraph.missing_trid_warning ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-900 dark:text-amber-100">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            missing_trid_warning
          </span>
        ) : null}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Claim case ID" value={preview.claim_case_id} mono />
        <Field label="Family" value={preview.family_key_v3 ?? "—"} />
        <Field label="Source event key" value={preview.source_event_key ?? "—"} mono />
        <Field label="Source event date" value={preview.source_event_date ?? "—"} />
        <Field label="ASIN" value={identity.asin ?? "—"} mono />
        <Field label="FNSKU" value={identity.fnsku ?? "—"} mono />
        <Field label="SKU" value={identity.sku ?? "—"} mono />
        <Field label="Clean quantity" value={preview.clean_quantity ?? "—"} />
        <Field label="TRID reference" value={refGraph.trid_reference ?? "—"} mono />
        <Field label="Tracking reference" value={refGraph.tracking_reference ?? "—"} mono />
      </dl>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          TRID / reference graph ({refGraph.lines.length})
        </h4>
        {refGraph.lines.length === 0 ? (
          <p className="text-xs opacity-60">
            No materialized reference edges — source anchors only (expected package + source event key).
          </p>
        ) : (
          <ul className="space-y-2">
            {refGraph.lines.map((line) => (
              <li
                key={`${line.kind}-${line.value}-${line.source}`}
                className="rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/5"
              >
                <span className="font-semibold">{line.kind}</span>
                <span className="mx-1 opacity-40">·</span>
                <span className="font-mono break-all">{line.value}</span>
                <p className="mt-1 opacity-55">{line.source}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Deterministic Amazon-facing draft summary
        </dt>
        <dd className="mt-1 rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
          {preview.amazon_facing_draft_text ?? "—"}
        </dd>
        <button
          type="button"
          onClick={() => void handleCopy("Summary", preview.amazon_facing_draft_text ?? "")}
          className="mt-2 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-semibold hover:bg-black/5 dark:hover:bg-white/5"
        >
          <ClipboardCopy className="h-3 w-3" aria-hidden />
          Copy summary
        </button>
      </div>

      <div>
        <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">Evidence summary</dt>
        <dd className="mt-1 rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
          {preview.evidence_summary ?? preview.internal_filing_summary ?? "—"}
        </dd>
      </div>

      {moneyWarnings.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
            Money warnings
          </h4>
          <div className="flex flex-wrap gap-2">
            {moneyWarnings.map((w) => (
              <span
                key={w}
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200"
              >
                {w}
              </span>
            ))}
          </div>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field
              label="Estimated Amazon payout"
              value={formatCaseReviewMoney(preview.money_lanes.estimated_amazon_payout)}
            />
            <Field
              label="Observed reimbursement"
              value={formatCaseReviewMoney(preview.money_lanes.observed_reimbursement)}
            />
          </dl>
        </div>
      ) : null}

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          DRAFT artifact paths (local audit export)
        </h4>
        <ul className="space-y-1 font-mono text-[10px] break-all">
          <li>
            <span className="opacity-55">folder · </span>
            {artifacts.folder}
          </li>
          <li>
            <span className="opacity-55">html · </span>
            {artifacts.html}
          </li>
          <li>
            <span className="opacity-55">json · </span>
            {artifacts.json}
          </li>
          <li>
            <span className="opacity-55">txt · </span>
            {artifacts.txt}
          </li>
          <li>
            <span className="opacity-55">pdf · </span>
            {artifacts.pdf}
          </li>
        </ul>
        <p className="mt-2 flex items-center gap-1 text-[10px] opacity-55">
          <ExternalLink className="h-3 w-3" aria-hidden />
          Open files from workspace audit folder — not uploaded to cloud storage.
        </p>
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Manual filing checklist
        </h4>
        <ul className="space-y-2">
          {MANUAL_FILING_HANDOFF_CHECKLIST_ITEMS.map((item) => (
            <li key={item.id} className="flex gap-2 rounded-lg border px-3 py-2 text-xs">
              <input
                type="checkbox"
                id={`handoff-${preview.claim_case_id}-${item.id}`}
                checked={!!checked[item.id]}
                onChange={(e) =>
                  setChecked((prev) => ({ ...prev, [item.id]: e.target.checked }))
                }
                className="mt-0.5"
                aria-label={item.label}
              />
              <label htmlFor={`handoff-${preview.claim_case_id}-${item.id}`} className="min-w-0">
                <span className="font-semibold">{item.label}</span>
                <p className="mt-0.5 opacity-70">{item.description}</p>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10px] opacity-55">
          Checklist is local-only — not saved to database.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleCopy("Identifiers", copyBundle)}
          className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-semibold hover:bg-black/5 dark:hover:bg-white/5"
        >
          <ClipboardCopy className="h-3 w-3" aria-hidden />
          Copy source/reference identifiers
        </button>
        <button
          type="button"
          onClick={() => void handleCopy("Quantity", String(preview.clean_quantity ?? ""))}
          className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-semibold hover:bg-black/5 dark:hover:bg-white/5"
        >
          <ClipboardCopy className="h-3 w-3" aria-hidden />
          Copy quantity
        </button>
      </div>

      {copyMsg ? <p className="text-[10px] opacity-70">{copyMsg}</p> : null}

      <div className="rounded-xl border border-dashed p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase opacity-55">Write actions (disabled)</p>
        <div className="flex flex-wrap gap-2">
          {MANUAL_FILING_HANDOFF_DISABLED_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled
              aria-disabled="true"
              title="Write actions unlock after operator-approved submission-record pilot"
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold opacity-45"
            >
              <Lock className="h-3.5 w-3.5" aria-hidden />
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {rowRemediated ? (
        <p className="text-xs text-amber-800 dark:text-amber-200">Handoff disabled for remediated cases.</p>
      ) : null}
    </div>
  );
}

export function ClaimCaseReviewManualFilingHandoffSection({
  row,
  pilotCaseRunId,
  intakeRunId,
  fetchJson,
}: Props) {
  const [preview, setPreview] = useState<ClaimFilingPacketPreviewV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const remediated = isRemediatedDuplicateCase(row);
  const handoffDisabled = manualFilingHandoffDisabled(row);

  const loadHandoff = useCallback(async () => {
    if (handoffDisabled) return;
    setLoading(true);
    setError(null);
    try {
      const params = handoffApiParams({
        caseId: row.id,
        pilotCaseRunId,
        intakeRunId,
        status: row.status ?? "open",
      });
      const data = await fetchJson<ClaimFilingPacketPreviewPayload>(FILING_PACKET_API_PATH, params);
      const item = data.previews.find((p) => p.claim_case_id === row.id) ?? data.previews[0] ?? null;
      if (!item) {
        setPreview(null);
        setError("No handoff preview composed for this case.");
      } else {
        setPreview(item);
      }
      setLoaded(true);
    } catch (e) {
      setPreview(null);
      setLoaded(true);
      setError(e instanceof Error ? e.message : "Failed to load manual filing handoff.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, handoffDisabled, intakeRunId, pilotCaseRunId, row.id, row.status]);

  return (
    <section id={MANUAL_FILING_HANDOFF_SECTION_ID} className="rounded-xl border border-dashed p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <HandHelping className="h-4 w-4 opacity-60" aria-hidden />
          <h3 className="text-xs font-semibold uppercase opacity-60">Manual filing handoff</h3>
        </div>
        <button
          type="button"
          onClick={() => void loadHandoff()}
          disabled={handoffDisabled || loading}
          aria-disabled={handoffDisabled || loading}
          title={
            handoffDisabled
              ? "Manual filing handoff disabled for remediated or closed cases"
              : "Load read-only manual filing handoff checklist"
          }
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-white/5"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <HandHelping className="h-3.5 w-3.5" aria-hidden />
          )}
          {MANUAL_FILING_HANDOFF_BUTTON_LABEL}
        </button>
      </div>

      {remediated ? (
        <div className="mb-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
          <p className="font-semibold">Remediation status</p>
          <p className="mt-1">{remediationStatusLabel(row)}</p>
          <p className="mt-1 opacity-80">Manual filing handoff is disabled for remediated duplicate cases.</p>
        </div>
      ) : (
        <p className="mb-3 text-xs opacity-70">
          Review the verified draft packet, copy identifiers, and file manually on Amazon Seller Central.
          No submission records are created in this phase.
        </p>
      )}

      {loading ? (
        <p className="flex items-center gap-2 text-xs opacity-70">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading handoff preview…
        </p>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
          <p className="font-semibold text-red-800 dark:text-red-200">Could not load handoff</p>
          <p className="mt-1 opacity-90">{error}</p>
        </div>
      ) : null}

      {preview && !error ? (
        <HandoffContent preview={preview} row={row} rowRemediated={remediated} />
      ) : loaded && !loading && !error && !handoffDisabled ? (
        <p className="text-xs opacity-60">No handoff preview loaded yet.</p>
      ) : null}
    </section>
  );
}
