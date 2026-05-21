"use client";

import Link from "next/link";
import { Bell, Home, ListTodo, Menu, ScanLine } from "lucide-react";
import { operatorHapticTap } from "../_lib/operator-haptics";

/** Warehouse receiving home (dashboard). */
export const SCANNER_OPERATOR_HOME_PATH = "/scanner/operator-mobile";
/** Active scan / pallet flow. */
export const SCANNER_OPERATOR_SCAN_PATH = "/scanner/operator-mobile/scan";

/** @deprecated Use SCANNER_OPERATOR_SCAN_PATH for the scan tab; kept for older imports. */
export const SCANNER_OPERATOR_MOBILE_PATH = SCANNER_OPERATOR_SCAN_PATH;

export type ScannerBottomNavActive = "home" | "scan" | "tasks" | "alerts" | "more";

export type ScannerBottomNavProps = {
  active?: ScannerBottomNavActive;
  /** When &gt; 0, Alerts shows a red count badge. */
  alertCount?: number;
};

function NavItem({
  href,
  label,
  active,
  icon: Icon,
  badge,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: typeof Home;
  badge?: number;
}) {
  const showBadge = typeof badge === "number" && badge > 0;
  const inactive = "operator-nav-inactive";
  const itemClass = `flex min-w-0 flex-1 flex-col items-center gap-0.5 py-0.5 ${active ? "" : inactive}`;
  const iconWrapClass = active
    ? "operator-nav-icon-wrap operator-nav-icon-wrap--active"
    : "operator-nav-icon-wrap";

  const iconWrap = (
    <span className={iconWrapClass}>
      <Icon className="h-6 w-6 shrink-0" strokeWidth={active ? 2.65 : 2.45} aria-hidden />
      {showBadge ? (
        <span
          className="operator-nav-alert-badge absolute -right-1.5 -top-1 z-[2] flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none text-white"
          style={{ backgroundColor: "var(--op-danger)" }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </span>
  );

  const body = (
    <>
      {iconWrap}
      <span className={`text-[11px] font-bold tracking-tight ${active ? "operator-nav-label-active" : "operator-nav-inactive"}`}>
        {label}
      </span>
      <span className="h-1.5 w-1.5 shrink-0" aria-hidden />
    </>
  );

  if (href === "#") {
    return <span className={itemClass}>{body}</span>;
  }

  return (
    <Link
      href={href}
      className={itemClass}
      aria-current={active ? "page" : undefined}
      onClick={() => operatorHapticTap(10)}
    >
      {body}
    </Link>
  );
}

/**
 * Bottom bar inside the 430px operator shell (not viewport-fixed): pair with a flex column + scrollable main.
 */
export function ScannerBottomNav({ active = "home", alertCount = 0 }: ScannerBottomNavProps) {
  return (
    <nav
      dir="ltr"
      className="shrink-0 border-t px-0 pt-1.5 pb-0.5 backdrop-blur-xl backdrop-saturate-150"
      style={{
        paddingBottom: "max(0.3rem, env(safe-area-inset-bottom))",
        borderColor: "var(--scanner-border)",
        backgroundColor: "color-mix(in srgb, var(--scanner-card-inner) 92%, transparent)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
      }}
      aria-label="Scanner navigation"
    >
      <div className="flex w-full flex-row">
        <NavItem href={SCANNER_OPERATOR_HOME_PATH} label="Home" active={active === "home"} icon={Home} />
        <NavItem href={SCANNER_OPERATOR_SCAN_PATH} label="Scan" active={active === "scan"} icon={ScanLine} />
        <NavItem href="#" label="Tasks" active={active === "tasks"} icon={ListTodo} />
        <NavItem href="#" label="Alerts" active={active === "alerts"} icon={Bell} badge={alertCount} />
        <NavItem href="#" label="More" active={active === "more"} icon={Menu} />
      </div>
    </nav>
  );
}
