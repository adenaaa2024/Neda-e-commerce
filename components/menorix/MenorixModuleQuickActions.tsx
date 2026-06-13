"use client";

import type { ReactNode } from "react";

import { MENORIX_MODULE_CARD_CLASS, MENORIX_TOUCH_MIN } from "./menorix-module-ui";

export type MenorixQuickAction = {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  locked?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
};

/**
 * Sticky bottom action bar — V1 read-only uses disabled/locked actions only.
 */
export function MenorixModuleQuickActions({
  actions,
  readOnlyLabel = "Actions available in a later phase",
}: {
  actions: MenorixQuickAction[];
  readOnlyLabel?: string;
}) {
  return (
    <div className={`${MENORIX_MODULE_CARD_CLASS} space-y-2 p-3`}>
      {readOnlyLabel ? <p className="text-[11px] opacity-60">{readOnlyLabel}</p> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={a.disabled !== false || a.locked}
            onClick={a.onClick}
            title={a.hint}
            className={`menorix-module-quick-action flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${MENORIX_TOUCH_MIN}`}
          >
            {a.icon}
            {a.label}
            {a.locked ? <span className="opacity-60">🔒</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
