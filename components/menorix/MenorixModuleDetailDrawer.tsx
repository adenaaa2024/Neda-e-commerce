"use client";

import type { ReactNode } from "react";

import { X } from "lucide-react";

import { MENORIX_MODULE_DRAWER_MOBILE_FULL, MENORIX_TOUCH_MIN } from "./menorix-module-ui";

export function MenorixModuleDetailDrawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  mobileFullScreen = true,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  mobileFullScreen?: boolean;
}) {
  if (!open) return null;

  const drawerClass = mobileFullScreen ? MENORIX_MODULE_DRAWER_MOBILE_FULL : "menorix-module-drawer fixed inset-y-0 right-0 z-[500] w-full max-w-lg border-l shadow-2xl";

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[490] bg-black/40"
        aria-label="Close detail"
        onClick={onClose}
      />
      <aside className={drawerClass} role="dialog" aria-label={title}>
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
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
          <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
          {footer ? (
            <div className="sticky bottom-0 border-t bg-inherit px-4 py-3 sm:px-5">{footer}</div>
          ) : null}
        </div>
      </aside>
    </>
  );
}
