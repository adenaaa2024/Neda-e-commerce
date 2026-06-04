"use client";

type OperatorPalletActionsPanelProps = {
  onVoidPallet: () => void;
};

/** Void pallet action — Pallet step Edit All mode only (operator mobile). */
export function OperatorPalletActionsPanel({ onVoidPallet }: OperatorPalletActionsPanelProps) {
  return (
    <div
      className="operator-pallet-actions mx-auto mt-2 flex w-full max-w-md flex-col gap-1.5 border-t pt-2"
      style={{ borderColor: "var(--scanner-border, #323c48)" }}
    >
      <p className="text-center text-[9px] font-bold uppercase tracking-widest opacity-70">
        Pallet actions
      </p>
      <button
        type="button"
        onClick={onVoidPallet}
        className="operator-pallet-actions__void h-8 min-h-[36px] w-full rounded-lg border px-2 text-[10px] font-bold uppercase tracking-wide transition active:scale-[0.98]"
      >
        Void Pallet
      </button>
    </div>
  );
}
