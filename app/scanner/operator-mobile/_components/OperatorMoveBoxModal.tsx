"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";

type OperatorMoveBoxModalProps = {
  open: boolean;
  packageLabel: string;
  busy: boolean;
  error: string | null;
  /** Target pallet from hardware scan (page capture) or manual entry. */
  target: string;
  onTargetChange: (value: string) => void;
  /** Refocus page scan capture after manual entry ends (keyboard-safe). */
  onRequestScanFocus?: () => void;
  onClose: () => void;
  onConfirm: (targetPalletTrackingOrNumber: string) => void;
};

export function OperatorMoveBoxModal({
  open,
  packageLabel,
  busy,
  error,
  target,
  onTargetChange,
  onRequestScanFocus,
  onClose,
  onConfirm,
}: OperatorMoveBoxModalProps) {
  const formId = useId();
  const [manualEntry, setManualEntry] = useState(false);
  const [step, setStep] = useState<"select" | "confirm">("select");
  const manualInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setManualEntry(false);
      setStep("select");
    }
  }, [open]);

  const exitManualEntry = useCallback(() => {
    setManualEntry(false);
    manualInputRef.current?.blur();
    onRequestScanFocus?.();
  }, [onRequestScanFocus]);

  const startManualEntry = useCallback(() => {
    setManualEntry(true);
    const focusManual = () => {
      const el = manualInputRef.current;
      if (!el) return;
      try {
        el.focus({ preventScroll: true });
        el.select();
      } catch {
        el.focus();
      }
    };
    window.requestAnimationFrame(focusManual);
    window.setTimeout(focusManual, 0);
  }, []);

  const handleClose = useCallback(() => {
    setManualEntry(false);
    setStep("select");
    onClose();
  }, [onClose]);

  if (!open) return null;

  const trimmedTarget = target.trim();

  if (step === "confirm") {
    return (
      <div
        className="operator-shipment-flow-modal fixed inset-0 z-[142] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${formId}-move-box-confirm-title`}
      >
        <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
          <p
            id={`${formId}-move-box-confirm-title`}
            className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
          >
            Move this box?
          </p>
          {packageLabel.trim() ? (
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[12px] font-semibold leading-relaxed">
              Box{" "}
              <span className="font-mono font-bold">{packageLabel.trim()}</span>
            </p>
          ) : null}
          <p className="operator-shipment-flow-modal__body mt-2 text-center text-[12px] font-medium leading-relaxed opacity-90">
            This will move this box/package and its scanned units to the selected pallet.
          </p>
          <p className="operator-shipment-flow-modal__note mt-2 text-center text-[11px] font-semibold leading-relaxed">
            Target: <span className="font-mono">{trimmedTarget}</span>
          </p>
          {error ? (
            <p className="mt-3 text-center text-[12px] font-semibold text-red-300" role="alert">
              {error}
            </p>
          ) : null}
          <OperatorScannerFooterActions
            className="mt-6"
            primary={
              <button
                type="button"
                disabled={busy}
                className="operator-shipment-flow-modal__btn-primary inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-50"
                onClick={() => onConfirm(trimmedTarget)}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Move box
              </button>
            }
            secondary={
              <button
                type="button"
                disabled={busy}
                className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-50"
                onClick={() => {
                  if (!busy) setStep("select");
                }}
              >
                Cancel
              </button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="operator-shipment-flow-modal fixed inset-0 z-[142] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${formId}-move-box-title`}
    >
      <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
        <p
          id={`${formId}-move-box-title`}
          className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
        >
          Move box to another pallet
        </p>
        <p className="operator-shipment-flow-modal__body mt-2 text-center text-[12px] font-semibold leading-relaxed">
          Box{" "}
          <span className="font-mono font-bold">{packageLabel || "—"}</span>
          <br />
          Scan the target pallet tracking number or pallet number.
        </p>
        <p
          className="mt-4 block text-[10px] font-bold uppercase tracking-widest opacity-80"
          id={`${formId}-move-target-label`}
        >
          Target pallet
        </p>
        <div className="mt-1">
          {manualEntry ? (
            <input
              ref={manualInputRef}
              id={`${formId}-move-target`}
              type="text"
              autoComplete="off"
              enterKeyHint="done"
              inputMode="text"
              value={target}
              onChange={(e) => onTargetChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  exitManualEntry();
                }
              }}
              onBlur={() => {
                window.setTimeout(() => setManualEntry(false), 120);
              }}
              disabled={busy}
              aria-labelledby={`${formId}-move-target-label`}
              className="scanner-input-glass block h-10 w-full rounded-lg border px-3 font-mono text-[13px] outline-none"
            />
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={startManualEntry}
              aria-labelledby={`${formId}-move-target-label`}
              className="scanner-input-glass flex h-10 w-full items-center justify-between gap-3 rounded-lg border px-3 text-left font-mono text-[13px] outline-none transition disabled:opacity-50"
            >
              <span className={`min-w-0 flex-1 truncate ${trimmedTarget ? "text-[var(--scanner-text,#f1f5f9)]" : "opacity-60"}`}>
                {trimmedTarget || "Ready to scan target pallet"}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-sky-200/85">
                <Pencil className="h-3 w-3" strokeWidth={2.25} aria-hidden />
                Tap to type
              </span>
            </button>
          )}
        </div>
        {error ? (
          <p className="mt-3 text-center text-[12px] font-semibold text-red-300" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={busy}
            className="operator-shipment-flow-modal__btn-secondary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-50"
            onClick={handleClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !trimmedTarget}
            className="operator-shipment-flow-modal__btn-primary inline-flex h-11 items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-50"
            onClick={() => {
              exitManualEntry();
              setStep("confirm");
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
