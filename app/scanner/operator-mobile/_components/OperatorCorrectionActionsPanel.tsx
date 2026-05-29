"use client";

type OperatorCorrectionActionsPanelProps = {
  showReset: boolean;
  showMoveBox: boolean;
  showVoidBox: boolean;
  onReset: () => void;
  onMoveBox: () => void;
  onVoidBox: () => void;
};

export function OperatorCorrectionActionsPanel({
  showReset,
  showMoveBox,
  showVoidBox,
  onReset,
  onMoveBox,
  onVoidBox,
}: OperatorCorrectionActionsPanelProps) {
  if (!showReset && !showMoveBox && !showVoidBox) return null;

  return (
    <div
      className="operator-correction-actions mx-auto mt-2 flex w-full max-w-md flex-col gap-1.5 border-t pt-2"
      style={{ borderColor: "var(--scanner-border, #323c48)" }}
    >
      <p className="text-center text-[9px] font-bold uppercase tracking-widest opacity-70">
        Corrections
      </p>
      <div className="flex flex-col gap-1.5">
        {showReset ? (
          <button
            type="button"
            onClick={onReset}
            className="h-9 w-full rounded-lg border text-[11px] font-bold uppercase tracking-wide transition active:scale-[0.98]"
            style={{
              borderColor: "var(--scanner-border, #323c48)",
              color: "var(--scanner-text, #faf6ed)",
            }}
          >
            Reset Current Entry
          </button>
        ) : null}
        {showMoveBox ? (
          <button
            type="button"
            onClick={onMoveBox}
            className="h-9 w-full rounded-lg border text-[11px] font-bold uppercase tracking-wide transition active:scale-[0.98]"
            style={{
              borderColor: "rgba(56,189,248,0.45)",
              backgroundColor: "rgba(14,116,144,0.2)",
              color: "var(--scanner-text, #faf6ed)",
            }}
          >
            Move Box
          </button>
        ) : null}
        {showVoidBox ? (
          <button
            type="button"
            onClick={onVoidBox}
            className="h-9 w-full rounded-lg border text-[11px] font-bold uppercase tracking-wide transition active:scale-[0.98]"
            style={{
              borderColor: "rgba(248,113,113,0.45)",
              backgroundColor: "rgba(127,29,29,0.25)",
              color: "#fecaca",
            }}
          >
            Void Box
          </button>
        ) : null}
      </div>
    </div>
  );
}
