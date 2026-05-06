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
  const inactive =
    "text-zinc-500 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300";
  const activeCls = "text-teal-600 dark:text-teal-400";

  const iconWrap = (
    <span className="relative flex h-7 w-7 items-center justify-center">
      <Icon
        className={`h-6 w-6 ${active ? "drop-shadow-[0_0_8px_rgba(13,148,136,0.4)] dark:drop-shadow-[0_0_12px_rgba(45,212,191,0.5)]" : ""}`}
        strokeWidth={active ? 2.4 : 1.9}
      />
      {showBadge ? (
        <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </span>
  );

  const body = (
    <>
      {iconWrap}
      <span
        className={`text-[11px] font-bold tracking-tight ${active ? "text-teal-600 dark:text-teal-400" : "text-zinc-600 dark:text-zinc-500"}`}
      >
        {label}
      </span>
      <span className="flex h-1.5 items-center justify-center" aria-hidden>
        {active ? (
          <span className="h-1.5 w-1.5 rounded-full bg-teal-500 shadow-[0_0_12px_rgba(20,184,166,0.55)] dark:bg-teal-400 dark:shadow-[0_0_12px_rgba(45,212,191,0.65)]" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-transparent" />
        )}
      </span>
    </>
  );

  if (href === "#") {
    return (
      <span className={`flex flex-1 flex-col items-center gap-0.5 py-1.5 ${active ? activeCls : inactive}`}>{body}</span>
    );
  }

  return (
    <Link
      href={href}
      className={`flex flex-1 flex-col items-center gap-0.5 py-1.5 ${active ? activeCls : inactive}`}
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
      className="shrink-0 border-t px-0 pt-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.88)] backdrop-blur-xl backdrop-saturate-150 dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]"
      style={{
        paddingBottom: "max(0.35rem, env(safe-area-inset-bottom))",
        borderColor: "var(--scanner-border)",
        backgroundColor: "color-mix(in srgb, var(--scanner-card) 78%, transparent)",
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
