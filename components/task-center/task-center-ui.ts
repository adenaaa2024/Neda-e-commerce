/** Task Center layout + styling tokens (read-only V1). */

export const TASK_CENTER_PAGE_CLASS = "w-full min-w-0 space-y-6 py-4 sm:py-6 lg:py-8";

export const TASK_CENTER_MAIN_CLASS =
  "task-center-main task-center-view min-h-0 flex-1 overflow-y-auto overflow-x-hidden";

export const TASK_CENTER_CARD_CLASS = "task-center-card relative w-full overflow-hidden rounded-xl border";

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
