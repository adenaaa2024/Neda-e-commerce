"use client";

import type { ReactNode } from "react";

import {
  MENORIX_MODULE_RAIL_CLASS,
  MENORIX_MODULE_SHELL_CLASS,
  MENORIX_MODULE_SURFACE_CLASS,
} from "./menorix-module-ui";
import type { MenorixModuleNavItem } from "./MenorixModuleSectionTabs";
import { MenorixModuleMobileBottomNav, MenorixModuleSectionTabs } from "./MenorixModuleSectionTabs";
import type { MenorixModuleViewMode } from "./menorix-module-ui";

/**
 * Reusable Menorix modular app shell.
 * Legacy module UIs (e.g. /claim-engine) remain separate — new apps use this pattern only.
 */
export function MenorixModuleAppShell({
  namespaceClass,
  moduleTitle,
  scopeBar,
  sectionNav,
  mobileNav,
  viewMode,
  onViewModeChange,
  showViewSwitch,
  showSectionTabs = true,
  fullWidth = false,
  rail,
  detailDrawer,
  lockedOverlay,
  mobileNavigation,
  hideRail = false,
  children,
}: {
  namespaceClass: string;
  moduleTitle: string;
  scopeBar?: ReactNode;
  sectionNav: MenorixModuleNavItem[];
  mobileNav?: MenorixModuleNavItem[];
  viewMode?: MenorixModuleViewMode;
  onViewModeChange?: (mode: MenorixModuleViewMode) => void;
  showViewSwitch?: boolean;
  /** When false, hides duplicate horizontal section tabs (Claim Center uses rail-only nav). */
  showSectionTabs?: boolean;
  /** When true, surface uses full monitor width instead of max-w-[1400px]. */
  fullWidth?: boolean;
  rail?: ReactNode;
  detailDrawer?: ReactNode;
  lockedOverlay?: ReactNode;
  /** Custom mobile nav (e.g. bottom bar + More sheet). Replaces mobileNav when set. */
  mobileNavigation?: ReactNode;
  /** When true, no inner module rail — ERP sidebar is the only vertical nav (Claim Center flow mode). */
  hideRail?: boolean;
  children: ReactNode;
}) {
  if (lockedOverlay) {
    return <div className={`${namespaceClass} ${MENORIX_MODULE_SHELL_CLASS}`}>{lockedOverlay}</div>;
  }

  const shellClass = hideRail
    ? "menorix-module-shell menorix-module-shell--no-rail flex min-h-0 flex-1 flex-col"
    : MENORIX_MODULE_SHELL_CLASS;

  return (
    <div className={`${namespaceClass} ${shellClass}`}>
      {!hideRail ? (
        <aside className={MENORIX_MODULE_RAIL_CLASS} aria-label={`${moduleTitle} navigation`}>
          {rail ?? (
            <div className="hidden p-3 lg:block">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide opacity-60">{moduleTitle}</p>
              <nav className="flex flex-col gap-1">
                {sectionNav.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className="menorix-module-rail__link rounded-lg px-3 py-2 text-sm font-medium opacity-80 hover:opacity-100 min-h-[44px] flex items-center"
                  >
                    {item.label}
                  </a>
                ))}
              </nav>
            </div>
          )}
        </aside>
      ) : null}

      <div className={`${MENORIX_MODULE_SURFACE_CLASS} pb-20 lg:pb-8`}>
        <div
          className={`mx-auto w-full space-y-4 px-4 sm:px-6 ${fullWidth ? "xl:px-8" : "max-w-[1400px]"}`}
        >
          {scopeBar}
          {showSectionTabs ? (
            <>
              <div className="lg:hidden">
                <MenorixModuleSectionTabs
                  items={sectionNav}
                  viewMode={viewMode}
                  onViewModeChange={onViewModeChange}
                  showViewSwitch={showViewSwitch}
                />
              </div>
              <div className="hidden lg:block">
                <MenorixModuleSectionTabs
                  items={sectionNav}
                  viewMode={viewMode}
                  onViewModeChange={onViewModeChange}
                  showViewSwitch={showViewSwitch}
                />
              </div>
            </>
          ) : null}
          {children}
        </div>
      </div>

      {detailDrawer}

      {mobileNavigation ?? (mobileNav?.length ? <MenorixModuleMobileBottomNav items={mobileNav} /> : null)}
    </div>
  );
}
