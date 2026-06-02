/** Shared layout + tab styling for claims workflow pages. */

export const CLAIM_ENGINE_PAGE_CLASS = "mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:px-8";

/** Horizontal workflow nav — scroll on narrow viewports. */
export const CLAIM_ENGINE_HUB_NAV_CLASS =
  "flex gap-1 overflow-x-auto overscroll-x-contain rounded-xl border border-slate-200 bg-white p-1 scrollbar-thin dark:border-slate-800 dark:bg-slate-950/80 [-webkit-overflow-scrolling:touch]";

export const CLAIM_ENGINE_STICKY_ACTION_BAR_CLASS =
  "pointer-events-auto fixed bottom-0 left-0 right-0 z-[450] border-t border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/95 sm:bottom-4 sm:left-1/2 sm:right-auto sm:w-[min(100vw-2rem,42rem)] sm:-translate-x-1/2 sm:rounded-2xl sm:border";

export const CLAIM_ENGINE_MAIN_CLASS =
  "min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-50 dark:bg-slate-950";

export function claimEngineSubTabClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
    active
      ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
  }`;
}

export const CLAIM_ENGINE_CARD_CLASS =
  "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950/70";

export const CLAIM_ENGINE_SECTION_CLASS =
  "space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/70";

export const CLAIM_ENGINE_TABLE_CLASS = "w-full text-left text-sm";

export const CLAIM_ENGINE_TABLE_HEAD_CLASS =
  "border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400";

export const CLAIM_ENGINE_TABLE_ROW_CLASS =
  "border-b border-slate-100 last:border-0 dark:border-slate-800/80";

export const CLAIM_ENGINE_INPUT_CLASS =
  "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

export const CLAIM_ENGINE_BTN_PRIMARY =
  "rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200";

export const CLAIM_ENGINE_BTN_SECONDARY =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200";

export const CLAIM_ENGINE_FILTER_TAB_ACTIVE =
  "rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900";

export const CLAIM_ENGINE_FILTER_TAB_IDLE =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";

export const CLAIM_ENGINE_KPI_CARD_CLASS =
  "rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/70";
