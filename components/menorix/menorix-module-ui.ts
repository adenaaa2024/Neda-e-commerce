/** Reusable layout + styling tokens for Menorix modular app shells (Claim Center, Product Center, …). */

export type MenorixModuleViewMode = "command" | "queue" | "board" | "table";

export const MENORIX_MODULE_SHELL_CLASS = "menorix-module-shell flex min-h-0 flex-1 flex-col lg:flex-row";

export const MENORIX_MODULE_RAIL_CLASS =
  "menorix-module-rail hidden shrink-0 border-b lg:flex lg:w-52 lg:flex-col lg:border-b-0 lg:border-r xl:w-56";

export const MENORIX_MODULE_SURFACE_CLASS = "menorix-module-surface min-w-0 flex-1";

export const MENORIX_MODULE_PAGE_CLASS = "w-full min-w-0 space-y-4 py-4 sm:space-y-6 sm:py-6";

export const MENORIX_MODULE_CARD_CLASS = "menorix-module-card rounded-xl";

export const MENORIX_MODULE_KPI_GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";

export const MENORIX_MODULE_KPI_CARD = "menorix-module-kpi rounded-xl p-3 sm:p-4";

export const MENORIX_MODULE_TILE_GRID = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3";

export const MENORIX_MODULE_TILE_CLASS =
  "menorix-module-tile group block rounded-xl p-4 text-left transition hover:opacity-95 min-h-[44px]";

export const MENORIX_MODULE_SECTION_TABS_CLASS =
  "menorix-module-section-tabs flex gap-1 overflow-x-auto overscroll-x-contain p-1 scrollbar-thin [-webkit-overflow-scrolling:touch]";

export function menorixModuleSectionTabClass(active: boolean): string {
  return `menorix-module-section-tabs__link shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold sm:text-sm min-h-[44px] inline-flex items-center${
    active ? " menorix-module-section-tabs__link--active" : ""
  }`;
}

export const MENORIX_MODULE_BOTTOM_NAV_CLASS =
  "menorix-module-bottom-nav fixed bottom-0 left-0 right-0 z-[440] flex border-t lg:hidden";

export function menorixModuleBottomNavLinkClass(active: boolean): string {
  return `menorix-module-bottom-nav__link flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-semibold${
    active ? " menorix-module-bottom-nav__link--active" : ""
  }`;
}

export const MENORIX_MODULE_DRAWER_CLASS =
  "menorix-module-drawer fixed inset-y-0 right-0 z-[500] w-full max-w-md border-l shadow-2xl sm:max-w-lg";

export const MENORIX_MODULE_DRAWER_MOBILE_FULL =
  "menorix-module-drawer menorix-module-drawer--mobile-full fixed inset-0 z-[500] flex flex-col sm:inset-y-0 sm:left-auto sm:w-full sm:max-w-lg sm:border-l";

export const MENORIX_MODULE_BADGE_BASE =
  "menorix-module-badge inline-flex min-h-[22px] items-center rounded-md px-2 py-0.5 text-[11px] font-semibold";

export function menorixModuleBadgeTone(tone: string): string {
  return `${MENORIX_MODULE_BADGE_BASE} menorix-module-badge--${tone}`;
}

export const MENORIX_MODULE_VIEW_SWITCH_CLASS = "menorix-module-view-switch inline-flex rounded-lg p-0.5";

export function menorixModuleViewSwitchBtn(active: boolean): string {
  return `menorix-module-view-switch__btn rounded-md px-3 py-1.5 text-xs font-semibold min-h-[44px] sm:min-h-0 sm:py-1${
    active ? " menorix-module-view-switch__btn--active" : ""
  }`;
}

export const MENORIX_TOUCH_MIN = "min-h-[44px] min-w-[44px]";
