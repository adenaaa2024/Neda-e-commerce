"use client";

import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";

type OperatorMoveBoxModalProps = {
  open: boolean;
  packageLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (targetPalletTrackingOrNumber: string) => void;
};

export function OperatorMoveBoxModal({
  open,
  packageLabel,
  busy,
  error,
  onClose,
  onConfirm,
}: OperatorMoveBoxModalProps) {
  const formId = useId();
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (open) setTarget("");
  }, [open]);

  if (!open) return null;

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
          Scan or enter the target pallet tracking number or pallet number.
        </p>
        <label
          htmlFor={`${formId}-move-target`}
          className="mt-4 block text-[10px] font-bold uppercase tracking-widest opacity-80"
        >
          Target pallet
        </label>
        <input
          id={`${formId}-move-target`}
          type="text"
          autoComplete="off"
          enterKeyHint="done"
          className="scanner-input-glass mt-1 block h-10 w-full rounded-lg border px-3 font-mono text-[13px] outline-none"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const t = target.trim();
              if (t && !busy) onConfirm(t);
            }
          }}
          disabled={busy}
        />
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
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !target.trim()}
            className="operator-shipment-flow-modal__btn-primary inline-flex h-11 items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-50"
            onClick={() => onConfirm(target.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Confirm Move
          </button>
        </div>
      </div>
    </div>
  );
}
