/** Shared layout + styling tokens for Claim Center V1 (read-only). */

export const CLAIM_CENTER_PAGE_CLASS = "w-full min-w-0 space-y-6 py-4 sm:py-6 lg:py-8";

export const CLAIM_CENTER_MAIN_CLASS =
  "claim-center-main claim-center-view min-h-0 flex-1 overflow-y-auto overflow-x-hidden";

export const CLAIM_CENTER_HUB_NAV_CLASS =
  "claim-center-hub-nav flex gap-1 overflow-x-auto overscroll-x-contain p-1 scrollbar-thin [-webkit-overflow-scrolling:touch]";

export function claimCenterHubLinkClass(active: boolean): string {
  return `claim-center-hub-nav__link shrink-0 whitespace-nowrap text-xs sm:text-sm${active ? " claim-center-hub-nav__link--active" : ""}`;
}

export const CLAIM_CENTER_CARD_CLASS = "claim-center-card relative w-full overflow-hidden rounded-xl";

export const CLAIM_CENTER_TABLE_CLASS = "claim-center-table w-full text-left text-sm";

export const CLAIM_CENTER_TABLE_HEAD_CLASS = "border-b";

export const CLAIM_CENTER_TABLE_ROW_CLASS = "border-b cursor-pointer hover:bg-black/5 dark:hover:bg-white/5";

export const CLAIM_CENTER_INPUT_CLASS = "claim-center-input w-full rounded-lg py-2 px-3 text-sm";

export const CLAIM_CENTER_SELECT_CLASS = "claim-center-select rounded-lg px-2 py-1.5 text-xs sm:text-sm";

export const CLAIM_CENTER_KPI_GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7";

export const CLAIM_CENTER_KPI_CARD = "claim-center-kpi rounded-xl p-3 sm:p-4";

export const CLAIM_CENTER_BADGE_BASE = "claim-center-badge inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold";

export function claimCenterBadgeTone(tone: string): string {
  return `${CLAIM_CENTER_BADGE_BASE} claim-center-badge--${tone}`;
}

export const CLAIM_CENTER_DRAWER_CLASS =
  "claim-center-drawer fixed inset-y-0 right-0 z-[500] w-full max-w-md border-l shadow-2xl sm:max-w-lg";

/** Wide desktop detail drawer — six-block story layout (xl: monitor width). */
export const CLAIM_CENTER_DETAIL_DRAWER_CLASS =
  "claim-center-detail-drawer fixed inset-y-0 right-0 z-[500] w-full max-w-3xl border-l shadow-2xl xl:max-w-5xl";

export const CLAIM_CENTER_DISABLED_BTN =
  "claim-center-btn claim-center-btn--disabled cursor-not-allowed opacity-60";
