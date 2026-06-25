/** Task Center layout + styling tokens (read-only V1). */

export const TASK_CENTER_PAGE_CLASS = "w-full min-w-0 space-y-6 py-4 sm:py-6 lg:py-8";

export const TASK_CENTER_MAIN_CLASS =
  "task-center-main task-center-view min-h-0 flex-1 overflow-y-auto overflow-x-hidden";

export const TASK_CENTER_CARD_CLASS = "task-center-card relative w-full overflow-hidden rounded-xl border";

export const TASK_CENTER_CARD_ACTIVE_CLASS = "task-center-card task-center-card--active relative w-full overflow-hidden rounded-xl border";

export const TASK_CENTER_KPI_GRID =
  "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4";

export const TASK_CENTER_KPI_CARD = "task-center-kpi rounded-xl border p-3 sm:p-4";

export const TASK_CENTER_BADGE_BASE =
  "task-center-badge inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold";

export function taskCenterBadgeTone(tone: string): string {
  return `${TASK_CENTER_BADGE_BASE} task-center-badge--${tone}`;
}

export const TASK_CENTER_DISABLED_BTN =
  "task-center-btn task-center-btn--disabled cursor-not-allowed opacity-60";

/** MENORIX typography — scoped under `.task-center-view` in theme CSS. */
export const TASK_CENTER_SUBTITLE = "mt-1 text-sm task-center-text-secondary";
export const TASK_CENTER_SECTION_LABEL = "text-sm font-bold uppercase tracking-wide task-center-section-label";
export const TASK_CENTER_MUTED = "task-center-text-muted";
export const TASK_CENTER_LINK = "text-xs font-semibold task-center-link";
export const TASK_CENTER_TOGGLE = "task-center-toggle rounded-lg px-3 py-1.5 text-xs font-semibold transition";
export const TASK_CENTER_TOGGLE_ACTIVE = "task-center-toggle task-center-toggle--active rounded-lg px-3 py-1.5 text-xs font-semibold transition";
export const TASK_CENTER_SELECT = "task-center-select rounded-lg border bg-transparent px-2 py-1.5 text-xs";
export const TASK_CENTER_SELECT_LG = "task-center-select min-h-[44px] rounded-lg border bg-transparent px-3 text-sm";
export const TASK_CENTER_STAT_PILL = "task-center-stat-pill rounded-lg border px-3 py-2";
export const TASK_CENTER_CHIP = "task-center-chip inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold transition";
export const TASK_CENTER_TYPE_BADGE = "task-center-type-badge rounded-md px-2 py-0.5 text-[11px] font-semibold";
export const TASK_CENTER_CTA = "task-center-cta inline-flex min-h-[44px] items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition hover:shadow-md";
export const TASK_CENTER_PHASE_NOTICE_CLASS = "task-center-phase-notice flex items-start gap-2 rounded-xl border text-xs leading-snug";
export const TASK_CENTER_READONLY_BANNER = "task-center-readonly-banner flex items-start gap-2 rounded-xl border px-4 py-3 text-xs leading-snug";
