/** Shared layout + premium MENORIX styling tokens for Claims workflow pages. */

export const CLAIM_ENGINE_PAGE_CLASS = "mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:px-8";

export const CLAIM_ENGINE_MAIN_CLASS =
  "claim-engine-main claim-engine-view min-h-0 flex-1 overflow-y-auto overflow-x-hidden";

/** Horizontal workflow nav — scroll on narrow viewports. */
export const CLAIM_ENGINE_HUB_NAV_CLASS =
  "claim-engine-hub-nav flex gap-1 overflow-x-auto overscroll-x-contain p-1 scrollbar-thin [-webkit-overflow-scrolling:touch]";

export function claimEngineHubLinkClass(active: boolean): string {
  return `claim-engine-hub-nav__link shrink-0 whitespace-nowrap${active ? " claim-engine-hub-nav__link--active" : ""}`;
}

export function claimEngineFilterTabClass(active: boolean): string {
  return `claim-engine-filter-tab${active ? " claim-engine-filter-tab--active" : ""}`;
}

/** @deprecated Use claimEngineFilterTabClass for in-page filter tabs. */
export function claimEngineSubTabClass(active: boolean): string {
  return claimEngineFilterTabClass(active);
}

export const CLAIM_ENGINE_STICKY_ACTION_BAR_CLASS =
  "claim-engine-sticky-bar pointer-events-auto fixed bottom-0 left-0 right-0 z-[450] px-4 py-3 sm:bottom-4 sm:left-1/2 sm:right-auto sm:w-[min(100vw-2rem,42rem)] sm:-translate-x-1/2 sm:rounded-2xl";

export const CLAIM_ENGINE_CARD_CLASS = "claim-engine-table-card relative w-full overflow-hidden";

export const CLAIM_ENGINE_SECTION_CLASS = "claim-engine-section";

export const CLAIM_ENGINE_TABLE_CLASS = "claim-engine-table w-full text-left text-sm";

export const CLAIM_ENGINE_TABLE_HEAD_CLASS = "border-b";

export const CLAIM_ENGINE_TABLE_ROW_CLASS = "border-b";

export const CLAIM_ENGINE_INPUT_CLASS = "claim-engine-search w-full py-2 px-3 text-sm";

export const CLAIM_ENGINE_SEARCH_INPUT_CLASS = "claim-engine-search w-full py-2 pl-9 pr-3 text-sm";

export const CLAIM_ENGINE_SEARCH_ICON_CLASS =
  "claim-engine-search-icon pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2";

export const CLAIM_ENGINE_SEARCH_WRAP_CLASS = "claim-engine-search-wrap border-b px-4 py-2.5";

export const CLAIM_ENGINE_SELECT_CLASS = "claim-engine-select px-2 py-1.5 text-xs";

export const CLAIM_ENGINE_BTN_PRIMARY = "claim-engine-btn claim-engine-btn--primary";

export const CLAIM_ENGINE_BTN_SECONDARY = "claim-engine-btn claim-engine-btn--neutral";

export const CLAIM_ENGINE_BTN_SUCCESS = "claim-engine-btn claim-engine-btn--success";

export const CLAIM_ENGINE_BTN_ACCENT = "claim-engine-btn claim-engine-btn--accent";

export const CLAIM_ENGINE_BTN_TRANSCRIPT = "claim-engine-btn claim-engine-btn--transcript";

export const CLAIM_ENGINE_FILTER_TAB_ACTIVE = "claim-engine-filter-tab claim-engine-filter-tab--active";

export const CLAIM_ENGINE_FILTER_TAB_IDLE = "claim-engine-filter-tab";

export const CLAIM_ENGINE_KPI_CARD_CLASS = "claim-engine-kpi";

/** Compact KPI tiles — policy summary strips (Draft pool). */
export const CLAIM_ENGINE_KPI_COMPACT_CARD_CLASS = "claim-engine-kpi claim-engine-kpi--compact";

export const CLAIM_ENGINE_KPI_LABEL_CLASS = "claim-engine-kpi__label";

export const CLAIM_ENGINE_KPI_VALUE_CLASS = "claim-engine-kpi__value";

export const CLAIM_ENGINE_KPI_HINT_CLASS = "claim-engine-kpi__hint";

export const CLAIM_ENGINE_TABLE_CARD_HEADER_CLASS =
  "claim-engine-table-card__header flex items-center justify-between border-b px-4 py-3.5";

export const CLAIM_ENGINE_TABLE_CARD_TITLE_CLASS =
  "claim-engine-table-card__title text-xs font-semibold tracking-tight";

export const CLAIM_ENGINE_TABLE_CARD_SUBTITLE_CLASS =
  "claim-engine-table-card__subtitle mt-0.5 text-[11px]";

export const CLAIM_ENGINE_TABLE_CARD_ICON_CLASS = "claim-engine-table-card__icon h-4 w-4";

export const CLAIM_ENGINE_MOBILE_CARD_CLASS = "claim-engine-mobile-card p-4";

export const CLAIM_ENGINE_MOBILE_CARD_TITLE_CLASS = "claim-engine-mobile-card__title text-sm";

export const CLAIM_ENGINE_EMPTY_FILTER_CLASS = "claim-engine-empty-filter px-6 py-10 text-center text-sm";

export const CLAIM_ENGINE_BANNER_ERROR_CLASS = "claim-engine-banner claim-engine-banner--error";

export const CLAIM_ENGINE_BANNER_WARNING_CLASS = "claim-engine-banner claim-engine-banner--warning";

export const CLAIM_ENGINE_BANNER_SUCCESS_CLASS = "claim-engine-banner claim-engine-banner--success";

export const CLAIM_ENGINE_BANNER_INFO_CLASS = "claim-engine-banner claim-engine-banner--info";

export const CLAIM_ENGINE_PROVIDER_CLASS =
  "claim-engine-provider inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold";

export const CLAIM_ENGINE_AMOUNT_CLASS = "claim-engine-amount";

export const CLAIM_ENGINE_PAYOUT_CLASS = "claim-engine-payout";

export const CLAIM_ENGINE_META_CLASS = "claim-engine-meta";

export const CLAIM_ENGINE_TYPE_CLASS = "claim-engine-type";

/** Map claim_submissions / claim row status to premium badge classes. */
export function claimEngineStatusClass(status: string): string {
  const map: Record<string, string> = {
    accepted: "claim-engine-status claim-engine-status--accepted",
    recovered: "claim-engine-status claim-engine-status--accepted",
    rejected: "claim-engine-status claim-engine-status--rejected",
    failed: "claim-engine-status claim-engine-status--failed",
    draft: "claim-engine-status claim-engine-status--neutral",
    ready_to_send: "claim-engine-status claim-engine-status--ready",
    submitted: "claim-engine-status claim-engine-status--submitted",
    investigating: "claim-engine-status claim-engine-status--info",
    evidence_requested: "claim-engine-status claim-engine-status--warning",
    pending: "claim-engine-status claim-engine-status--warning",
    suspicious: "claim-engine-status claim-engine-status--danger",
    cancelled: "claim-engine-status claim-engine-status--neutral",
  };
  return map[status] ?? "claim-engine-status claim-engine-status--neutral";
}
