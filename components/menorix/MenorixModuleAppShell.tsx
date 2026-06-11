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
  rail,
  detailDrawer,
  lockedOverlay,
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
  rail?: ReactNode;
  detailDrawer?: ReactNode;
  lockedOverlay?: ReactNode;
  children: ReactNode;
}) {
  if (lockedOverlay) {
    return <div className={`${namespaceClass} ${MENORIX_MODULE_SHELL_CLASS}`}>{lockedOverlay}</div>;
  }

  return (
    <div className={`${namespaceClass} ${MENORIX_MODULE_SHELL_CLASS}`}>
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

      <div className={`${MENORIX_MODULE_SURFACE_CLASS} pb-20 lg:pb-8`}>
        <div className="mx-auto w-full max-w-[1400px] space-y-4 px-4 sm:px-6">
          {scopeBar}
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
          {children}
        </div>
      </div>

      {detailDrawer}

      {mobileNav?.length ? <MenorixModuleMobileBottomNav items={mobileNav} /> : null}
    </div>
  );
}
