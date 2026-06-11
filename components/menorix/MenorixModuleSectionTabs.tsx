"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import {
  MENORIX_MODULE_BOTTOM_NAV_CLASS,
  MENORIX_MODULE_SECTION_TABS_CLASS,
  MENORIX_MODULE_VIEW_SWITCH_CLASS,
  type MenorixModuleViewMode,
  menorixModuleBottomNavLinkClass,
  menorixModuleSectionTabClass,
  menorixModuleViewSwitchBtn,
} from "./menorix-module-ui";

export type MenorixModuleNavItem = {
  href: string;
  label: string;
  shortLabel?: string;
  exact?: boolean;
  icon?: ReactNode;
};

const VIEW_MODES: { id: MenorixModuleViewMode; label: string }[] = [
  { id: "command", label: "Command" },
  { id: "queue", label: "Queue" },
  { id: "table", label: "Table" },
];

export function MenorixModuleSectionTabs({
  items,
  viewMode,
  onViewModeChange,
  showViewSwitch = false,
}: {
  items: MenorixModuleNavItem[];
  viewMode?: MenorixModuleViewMode;
  onViewModeChange?: (mode: MenorixModuleViewMode) => void;
  showViewSwitch?: boolean;
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
        <div className={MENORIX_MODULE_VIEW_SWITCH_CLASS} role="group" aria-label="View mode">
          {VIEW_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={menorixModuleViewSwitchBtn(viewMode === m.id)}
              onClick={() => onViewModeChange(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
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
