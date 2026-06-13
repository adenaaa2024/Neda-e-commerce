"use client";

import type { ReactNode } from "react";

import { X } from "lucide-react";

import { MENORIX_TOUCH_MIN } from "./menorix-module-ui";

/**
 * Full-screen mobile detail sheet (slides up). Desktop can use MenorixModuleDetailDrawer instead.
 */
export function MenorixModuleMobileDetailSheet({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[490] bg-black/50 lg:hidden"
        aria-label="Close detail"
        onClick={onClose}
      />
      <div
        className="menorix-module-mobile-sheet fixed inset-x-0 bottom-0 top-0 z-[500] flex flex-col lg:hidden"
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-center pt-2">
          <span className="h-1 w-10 rounded-full bg-black/20 dark:bg-white/20" aria-hidden />
        </div>
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            {subtitle ? <p className="text-xs font-medium uppercase tracking-wide opacity-60">{subtitle}</p> : null}
            <h2 className="truncate text-lg font-bold">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-lg p-2 hover:bg-black/10 dark:hover:bg-white/10 ${MENORIX_TOUCH_MIN}`}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <div className="sticky bottom-0 border-t bg-inherit px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : null}
      </div>
    </>
  );
}
