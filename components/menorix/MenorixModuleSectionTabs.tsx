"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import {
  MENORIX_MODULE_BOTTOM_NAV_CLASS,
  MENORIX_MODULE_SECTION_TABS_CLASS,
  type MenorixModuleViewMode,
  menorixModuleBottomNavLinkClass,
  menorixModuleSectionTabClass,
} from "./menorix-module-ui";
import { MenorixModuleViewSwitcher } from "./MenorixModuleViewSwitcher";

export type MenorixModuleNavItem = {
  href: string;
  label: string;
  shortLabel?: string;
  exact?: boolean;
  icon?: ReactNode;
};

export function MenorixModuleSectionTabs({
  items,
  viewMode,
  onViewModeChange,
  showViewSwitch = false,
  viewSwitchCompact,
}: {
  items: MenorixModuleNavItem[];
  viewMode?: MenorixModuleViewMode;
  onViewModeChange?: (mode: MenorixModuleViewMode) => void;
  showViewSwitch?: boolean;
  viewSwitchCompact?: boolean;
}) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <nav className={MENORIX_MODULE_SECTION_TABS_CLASS} aria-label="Module sections">
        {items.map((item) => {
          const active =
            item.exact === true
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link key={item.href} href={item.href} className={menorixModuleSectionTabClass(active)}>
              {item.label}
            </Link>
          );
        })}
      </nav>
      {showViewSwitch && viewMode && onViewModeChange ? (
        <MenorixModuleViewSwitcher value={viewMode} onChange={onViewModeChange} compact={viewSwitchCompact} />
      ) : null}
    </div>
  );
}

export function MenorixModuleMobileBottomNav({ items, maxItems = 5 }: { items: MenorixModuleNavItem[]; maxItems?: number }) {
  const pathname = usePathname();
  const navItems = items.slice(0, maxItems);

  return (
    <nav className={MENORIX_MODULE_BOTTOM_NAV_CLASS} aria-label="Module mobile navigation">
      {navItems.map((item) => {
        const active =
          item.exact === true
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} className={menorixModuleBottomNavLinkClass(active)}>
            {item.icon}
            <span>{item.shortLabel ?? item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
