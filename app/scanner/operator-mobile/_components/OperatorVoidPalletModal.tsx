"use client";

import { Loader2 } from "lucide-react";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";

type OperatorVoidPalletModalProps = {
  open: boolean;
  palletLabel: string;
  packageCount: number;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
};

export function OperatorVoidPalletModal({
  open,
  palletLabel,
  packageCount,
  busy,
  error,
  onClose,
  onConfirm,
}: OperatorVoidPalletModalProps) {
  if (!open) return null;

  const hasLinkedPackages = packageCount > 0;

  return (
    <div
      className="operator-shipment-flow-modal fixed inset-0 z-[142] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="operator-void-pallet-title"
    >
      <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
        <p
          id="operator-void-pallet-title"
          className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
        >
          Void pallet?
        </p>
        <p className="operator-shipment-flow-modal__body mt-3 text-center text-[12px] font-semibold leading-relaxed">
          Pallet{" "}
          <span className="font-mono font-bold">{palletLabel || "—"}</span>
        </p>
        <p className="operator-shipment-flow-modal__body mt-2 text-center text-[12px] font-medium leading-relaxed opacity-90">
          This will remove this pallet from active receiving. Packages/items linked to it may be released or
          remain according to existing void rules.
        </p>
        {hasLinkedPackages ? (
          <p
            className="operator-shipment-flow-modal__alert mt-3 rounded-xl px-3 py-2.5 text-center text-[11px] font-semibold leading-snug"
            role="status"
          >
            This pallet has {packageCount} active box{packageCount === 1 ? "" : "es"} on record. Voiding will
            soft-remove the pallet and linked packages per existing void rules.
          </p>
        ) : null}
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
              Void Pallet
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
