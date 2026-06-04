"use client";

import { Loader2 } from "lucide-react";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";

type OperatorVoidBoxModalProps = {
  open: boolean;
  packageLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
};

export function OperatorVoidBoxModal({
  open,
  packageLabel,
  busy,
  error,
  onClose,
  onConfirm,
}: OperatorVoidBoxModalProps) {
  if (!open) return null;

  return (
    <div
      className="operator-shipment-flow-modal fixed inset-0 z-[142] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="operator-void-box-title"
    >
      <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
        <p
          id="operator-void-box-title"
          className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
        >
          Void this box?
        </p>
        {packageLabel.trim() ? (
          <p className="operator-shipment-flow-modal__body mt-3 text-center text-[12px] font-semibold leading-relaxed">
            Box{" "}
            <span className="font-mono font-bold">{packageLabel.trim()}</span>
          </p>
        ) : null}
        <p className="operator-shipment-flow-modal__body mt-2 text-center text-[12px] font-medium leading-relaxed opacity-90">
          This will void this box/package and its scanned units from the current receiving flow.
          This action cannot be undone.
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
              className="operator-shipment-flow-modal__btn-danger inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-50"
              onClick={onConfirm}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Void box
            </button>
          }
          secondary={
            <button
              type="button"
              disabled={busy}
              className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-50"
              onClick={onClose}
            >
              Cancel
            </button>
          }
        />
      </div>
    </div>
  );
}
