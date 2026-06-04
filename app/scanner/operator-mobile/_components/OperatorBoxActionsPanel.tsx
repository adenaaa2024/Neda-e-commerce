"use client";

type OperatorBoxActionsPanelProps = {
  onMoveBox: () => void;
  onVoidBox: () => void;
};

/** Move / Void box actions — Box Info Edit All mode only (operator mobile). */
export function OperatorBoxActionsPanel({
  onMoveBox,
  onVoidBox,
}: OperatorBoxActionsPanelProps) {
  return (
    <div
      className="operator-box-actions mx-auto mt-2 flex w-full max-w-md flex-col gap-1.5 border-t pt-2"
      style={{ borderColor: "var(--scanner-border, #323c48)" }}
    >
      <p className="text-center text-[9px] font-bold uppercase tracking-widest opacity-70">
        Box actions
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={onMoveBox}
          className="operator-box-actions__move h-8 min-h-[36px] w-full rounded-lg border px-2 text-[10px] font-bold uppercase tracking-wide transition active:scale-[0.98]"
        >
          Move Box
        </button>
        <button
          type="button"
          onClick={onVoidBox}
          className="operator-box-actions__void h-8 min-h-[36px] w-full rounded-lg border px-2 text-[10px] font-bold uppercase tracking-wide transition active:scale-[0.98]"
        >
          Void Box
        </button>
      </div>
    </div>
  );
}
