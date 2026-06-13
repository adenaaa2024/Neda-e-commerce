"use client";

import type { ReactNode } from "react";

import { SlidersHorizontal, X } from "lucide-react";

import { MENORIX_TOUCH_MIN } from "./menorix-module-ui";

export function MenorixModuleMobileFilterSheet({
  open,
  title = "Filters",
  onClose,
  children,
  onApply,
  applyLabel = "Apply filters",
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
  onApply?: () => void;
  applyLabel?: string;
}) {
  if (!open) return null;

  return (
    <>
      <button type="button" className="fixed inset-0 z-[480] bg-black/40" aria-label="Close filters" onClick={onClose} />
      <div className="menorix-module-filter-sheet fixed inset-x-0 bottom-0 z-[485] max-h-[85vh] rounded-t-2xl border-t shadow-2xl lg:hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 opacity-60" />
            <h2 className="text-sm font-bold">{title}</h2>
          </div>
          <button type="button" onClick={onClose} className={`rounded-lg p-2 ${MENORIX_TOUCH_MIN}`} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-4 py-4">{children}</div>
        <div className="border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            className={`menorix-module-btn-primary w-full rounded-lg py-3 text-sm font-semibold ${MENORIX_TOUCH_MIN}`}
            onClick={() => {
              onApply?.();
              onClose();
            }}
          >
            {applyLabel}
          </button>
        </div>
      </div>
    </>
  );
}
