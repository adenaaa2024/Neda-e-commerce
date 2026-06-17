"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock, ShieldCheck, X } from "lucide-react";

import type { ReimbursementTrackingPreviewRow } from "@/lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  EMPTY_MANUAL_FILING_FORM,
  MANUAL_FILING_EXECUTE_DISABLED_TOOLTIP,
  MANUAL_FILING_UI_COPY,
  assessManualFilingRecordEligibility,
  buildManualFilingDryRunPreview,
  validateManualFilingForm,
  type ManualFilingDryRunPreview,
  type ManualFilingFormState,
} from "@/lib/claims/submission/claim-manual-filing-status-entry-ui-contract";
import { CLAIM_CENTER_INPUT_CLASS } from "@/components/claim-center/claim-center-ui";

type Props = {
  open: boolean;
  row: ReimbursementTrackingPreviewRow;
  onClose: () => void;
  fetchJson: <T>(path: string, extra?: Record<string, string>, init?: RequestInit) => Promise<T>;
};

export function ReimbursementTrackingManualFilingModal({ open, row, onClose, fetchJson }: Props) {
  const [form, setForm] = useState<ManualFilingFormState>(EMPTY_MANUAL_FILING_FORM);
  const [preview, setPreview] = useState<ManualFilingDryRunPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeSuccess, setExecuteSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_MANUAL_FILING_FORM);
      setPreview(null);
      setPreviewError(null);
      setWriteEnabled(false);
      setExecuteError(null);
      setExecuteSuccess(null);
    }
  }, [open, row.claim_submission_id]);

  const validation = validateManualFilingForm(form);
  const eligibility = assessManualFilingRecordEligibility(row);

  const runDryRun = useCallback(async () => {
    const v = validateManualFilingForm(form);
    if (!v.valid) {
      setPreviewError("Complete all required fields and confirm attestation.");
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const localPreview = buildManualFilingDryRunPreview(row, form);
      setPreview(localPreview);

      const server = await fetchJson<{
        preview: ManualFilingDryRunPreview | null;
        write_approval_status?: { write_enabled?: boolean };
        error: string | null;
      }>("/api/claims/center/manual-filing-status-entry/dry-run", undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim_submission_id: row.claim_submission_id,
          amazon_case_id: form.amazon_case_id,
          filed_at: form.filed_at,
          amazon_case_url: form.amazon_case_url,
          filing_notes: form.filing_notes,
          attestation: form.attestation,
        }),
      });
      if (server.preview) {
        setPreview(server.preview);
        setWriteEnabled(
          server.write_approval_status?.write_enabled === true || server.preview.write_enabled === true,
        );
      } else if (server.error) setPreviewError(server.error);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Dry-run preview failed.");
    } finally {
      setPreviewLoading(false);
    }
  }, [fetchJson, form, row]);

  const runExecute = useCallback(async () => {
    const v = validateManualFilingForm(form);
    if (!v.valid || !preview || !writeEnabled) return;
    setExecuteLoading(true);
    setExecuteError(null);
    setExecuteSuccess(null);
    try {
      const result = await fetchJson<{
        ok?: boolean;
        blocked?: boolean;
        blockReason?: string | null;
        written?: boolean;
      }>("/api/claims/center/manual-filing-status-entry/execute", undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim_submission_id: row.claim_submission_id,
          amazon_case_id: form.amazon_case_id,
          filed_at: form.filed_at,
          amazon_case_url: form.amazon_case_url,
          filing_notes: form.filing_notes,
          attestation: form.attestation,
        }),
      });
      if (result.blocked) {
        setExecuteError(result.blockReason ?? "Write blocked by approval gate.");
      } else if (result.ok && result.written) {
        setExecuteSuccess("Manual filing recorded — not submitted by MENORIX.");
      } else {
        setExecuteError(result.blockReason ?? "Execute failed.");
      }
    } catch (e) {
      setExecuteError(e instanceof Error ? e.message : "Execute failed.");
    } finally {
      setExecuteLoading(false);
    }
  }, [fetchJson, form, preview, row.claim_submission_id, writeEnabled]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[600] bg-black/50"
        aria-label="Close modal"
        onClick={onClose}
      />
      <div
        className="claim-center-card fixed inset-x-4 top-[8vh] z-[610] mx-auto flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border shadow-2xl sm:inset-x-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-filing-modal-title"
      >
        <div className="flex items-start justify-between border-b px-4 py-3">
          <div>
            <h2 id="manual-filing-modal-title" className="text-base font-semibold">
              {MANUAL_FILING_UI_COPY.modal_title}
            </h2>
            <p className="mt-1 text-xs opacity-70">{MANUAL_FILING_UI_COPY.modal_subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 opacity-70 hover:opacity-100" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
          <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-950 dark:text-sky-100">
            <ShieldCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            {MANUAL_FILING_UI_COPY.safety_banner}
          </p>

          {!eligibility.button_enabled && eligibility.disabled_reason ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
              {eligibility.disabled_reason}
            </p>
          ) : null}

          <label className="block text-xs">
            <span className="mb-1 block font-semibold uppercase opacity-60">Amazon Case ID *</span>
            <input
              className={CLAIM_CENTER_INPUT_CLASS}
              value={form.amazon_case_id}
              onChange={(e) => setForm((f) => ({ ...f, amazon_case_id: e.target.value }))}
              placeholder="Seller Central case ID"
              autoComplete="off"
            />
            {validation.errors.amazon_case_id ? (
              <span className="mt-1 block text-[11px] text-red-600">{validation.errors.amazon_case_id}</span>
            ) : null}
          </label>

          <label className="block text-xs">
            <span className="mb-1 block font-semibold uppercase opacity-60">Filed date/time *</span>
            <input
              type="datetime-local"
              className={CLAIM_CENTER_INPUT_CLASS}
              value={form.filed_at}
              onChange={(e) => setForm((f) => ({ ...f, filed_at: e.target.value }))}
            />
            {validation.errors.filed_at ? (
              <span className="mt-1 block text-[11px] text-red-600">{validation.errors.filed_at}</span>
            ) : null}
          </label>

          <label className="block text-xs">
            <span className="mb-1 block font-semibold uppercase opacity-60">External Amazon case URL</span>
            <input
              className={CLAIM_CENTER_INPUT_CLASS}
              value={form.amazon_case_url}
              onChange={(e) => setForm((f) => ({ ...f, amazon_case_url: e.target.value }))}
              placeholder="https://sellercentral.amazon.com/…"
            />
            {validation.errors.amazon_case_url ? (
              <span className="mt-1 block text-[11px] text-red-600">{validation.errors.amazon_case_url}</span>
            ) : null}
          </label>

          <label className="block text-xs">
            <span className="mb-1 block font-semibold uppercase opacity-60">Notes</span>
            <textarea
              className={`${CLAIM_CENTER_INPUT_CLASS} min-h-[72px]`}
              value={form.filing_notes}
              onChange={(e) => setForm((f) => ({ ...f, filing_notes: e.target.value }))}
              placeholder="Optional operator notes"
            />
          </label>

          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.attestation}
              onChange={(e) => setForm((f) => ({ ...f, attestation: e.target.checked }))}
            />
            <span>{MANUAL_FILING_UI_COPY.confirmation_checkbox}</span>
          </label>
          {validation.errors.attestation ? (
            <span className="block text-[11px] text-red-600">{validation.errors.attestation}</span>
          ) : null}

          {preview ? (
            <section className="rounded-lg border bg-black/[0.02] p-3 dark:bg-white/[0.02]">
              <h3 className="text-xs font-semibold uppercase opacity-60">{MANUAL_FILING_UI_COPY.preview_heading}</h3>
              <dl className="mt-2 space-y-2 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="opacity-60">Old status</dt>
                  <dd className="font-mono">{preview.old_status}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="opacity-60">New status</dt>
                  <dd className="font-mono">{preview.new_status}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="opacity-60">Tracking status</dt>
                  <dd className="font-mono">{preview.new_tracking_status}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="opacity-60">submission_id preview</dt>
                  <dd className="font-mono break-all">{preview.submission_id_preview}</dd>
                </div>
              </dl>
              <details className="mt-3">
                <summary className="cursor-pointer text-[11px] font-semibold opacity-70">source_payload preview</summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded border bg-black/5 p-2 text-[10px] dark:bg-white/5">
                  {JSON.stringify(preview.source_payload_preview, null, 2)}
                </pre>
              </details>
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-semibold opacity-70">Audit event preview</summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded border bg-black/5 p-2 text-[10px] dark:bg-white/5">
                  {JSON.stringify(preview.audit_event_preview, null, 2)}
                </pre>
              </details>
            </section>
          ) : null}

          {previewError ? <p className="text-xs text-red-600">{previewError}</p> : null}
          {executeError ? <p className="text-xs text-red-600">{executeError}</p> : null}
          {executeSuccess ? (
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-100">
              {executeSuccess}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="claim-center-btn rounded-lg border px-4 py-2 text-xs font-semibold opacity-80"
          >
            {MANUAL_FILING_UI_COPY.cancel_label}
          </button>
          <button
            type="button"
            onClick={() => void runDryRun()}
            disabled={!validation.valid || previewLoading || !eligibility.button_enabled}
            className="claim-center-btn claim-center-btn--primary inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold disabled:opacity-50"
          >
            {previewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Preview dry-run
          </button>
          {writeEnabled && preview ? (
            <button
              type="button"
              onClick={() => void runExecute()}
              disabled={executeLoading}
              className="claim-center-btn claim-center-btn--primary inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {executeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {MANUAL_FILING_UI_COPY.save_label}
            </button>
          ) : (
            <button
              type="button"
              disabled
              title={MANUAL_FILING_EXECUTE_DISABLED_TOOLTIP}
              className="claim-center-btn claim-center-btn--disabled inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold"
            >
              <Lock className="h-3.5 w-3.5" aria-hidden />
              {MANUAL_FILING_UI_COPY.save_label}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
