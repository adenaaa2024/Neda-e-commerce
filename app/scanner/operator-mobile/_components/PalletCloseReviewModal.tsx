"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useMemo, useState } from "react";

import type { PalletCloseReviewModel } from "@/lib/scanner/pallet-close-review";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";

type PalletCloseReviewModalProps = {
  formId: string;
  model: PalletCloseReviewModel;
  busy: boolean;
  finalizeBusy: boolean;
  onCancel: () => void;
  onConfirm: (args: { criticalIssuesAcknowledged: boolean; auditNote: string | null }) => void;
};

export function PalletCloseReviewModal(props: PalletCloseReviewModalProps) {
  const { formId, model, busy, finalizeBusy, onCancel, onConfirm } = props;

  const [reviewChecked, setReviewChecked] = useState(false);
  const [criticalAck, setCriticalAck] = useState(false);
  const [auditNote, setAuditNote] = useState("");

  const confirmDisabled = useMemo(() => {
    if (!reviewChecked) return true;
    if (model.has_critical_issues && !criticalAck) return true;
    return false;
  }, [reviewChecked, model.has_critical_issues, criticalAck]);

  return (
    <div
      className="operator-shipment-flow-modal fixed inset-0 z-[143] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${formId}-pallet-review-title`}
    >
      <div className="operator-shipment-flow-modal__panel flex max-h-[min(90vh,720px)] w-full max-w-md flex-col rounded-[24px] border p-5">
        <p
          id={`${formId}-pallet-review-title`}
          className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
        >
          Pallet review
        </p>
        <p className="operator-shipment-flow-modal__body mt-2 text-center text-[13px] font-semibold leading-snug">
          Review all boxes on this pallet before close. Missing stays review status only — claims are
          created later.
        </p>
        <p className="operator-shipment-flow-modal__body mt-2 text-center text-[13px] font-semibold leading-relaxed tabular-nums">
          Boxes <span className="font-mono font-bold">{model.package_count}</span>
          {" · "}
          Expected <span className="font-mono font-bold">{model.totals.expected_qty}</span>
          {" · "}
          Received <span className="font-mono font-bold">{model.totals.received_qty}</span>
        </p>

        <div className="operator-box-close-review mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border px-3 py-2.5">
          {model.buckets.length === 0 ? (
            <p className="text-center text-[11px] font-semibold leading-snug opacity-80">
              No review buckets — totals only.
            </p>
          ) : (
            <ul className="space-y-3">
              {model.buckets.map((bucket) => (
                <li key={bucket.key}>
                  <div className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wide">
                    <span>{bucket.title}</span>
                    <span className="font-black tabular-nums">{bucket.count}</span>
                  </div>
                  {bucket.lines.length > 0 ? (
                    <ul className="mt-1 space-y-1">
                      {bucket.lines.slice(0, 6).map((line) => (
                        <li
                          key={`${bucket.key}:${line.lineKey}`}
                          className="flex items-start justify-between gap-2 text-[11px] font-semibold leading-snug"
                        >
                          <span className="min-w-0 truncate">{line.label}</span>
                          <span className="shrink-0 font-mono tabular-nums">{line.qty}</span>
                        </li>
                      ))}
                      {bucket.lines.length > 6 ? (
                        <li className="text-[10px] font-semibold opacity-70">
                          +{bucket.lines.length - 6} more line{bucket.lines.length - 6 === 1 ? "" : "s"}
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {model.has_critical_issues ? (
          <div className="operator-shipment-flow-modal__alert mt-3 rounded-xl px-3 py-2.5 text-[11px] font-semibold leading-snug">
            <strong>Unresolved issues:</strong> {model.critical_issue_labels.join(" · ")}
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={criticalAck}
                onChange={(e) => setCriticalAck(e.target.checked)}
              />
              <span>I acknowledge unresolved issues and want to close this pallet anyway.</span>
            </label>
            <textarea
              className="mt-2 w-full rounded-lg border bg-transparent px-2 py-1.5 text-[11px] font-medium"
              rows={2}
              placeholder="Optional audit note (stored on pallet close snapshot)"
              value={auditNote}
              onChange={(e) => setAuditNote(e.target.value)}
            />
          </div>
        ) : null}

        <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12px] font-semibold leading-snug">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={reviewChecked}
            onChange={(e) => setReviewChecked(e.target.checked)}
          />
          <span>I reviewed this pallet and want to close.</span>
        </label>

        <OperatorScannerFooterActions
          className="mt-4 shrink-0"
          primary={
            <button
              type="button"
              disabled={busy || finalizeBusy || confirmDisabled}
              className={`flex w-full items-center justify-center gap-2 rounded-xl border transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
                model.has_critical_issues
                  ? "border-amber-500/50 bg-amber-100 text-amber-950"
                  : "border-[#C8A96A]/55 bg-gradient-to-b from-[#3d4550] to-[#171c22] text-[#faf6ed]"
              } h-11 text-[13px] font-bold`}
              onClick={() =>
                onConfirm({
                  criticalIssuesAcknowledged: model.has_critical_issues ? criticalAck : true,
                  auditNote: auditNote.trim() || null,
                })
              }
            >
              {model.has_critical_issues ? (
                <>
                  <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2.35} aria-hidden />
                  {finalizeBusy ? "Closing…" : "Close with issues"}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 shrink-0" strokeWidth={2.75} aria-hidden />
                  {finalizeBusy ? "Closing…" : "Close pallet"}
                </>
              )}
            </button>
          }
          secondary={
            <button
              type="button"
              className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
              onClick={onCancel}
            >
              Cancel
            </button>
          }
        />
      </div>
    </div>
  );
}
