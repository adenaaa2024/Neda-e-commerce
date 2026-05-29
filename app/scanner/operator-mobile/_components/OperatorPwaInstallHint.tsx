"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ScanLine, X } from "lucide-react";
import { SCANNER_OPERATOR_SCAN_PATH } from "./ScannerBottomNav";

const DISMISS_KEY = "operatorMobile:pwaHintDismissed";

function isMobileClient(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia("(max-width: 768px)").matches;
  const ua = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
  return coarse || ua;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

/**
 * Lightweight install / open-scanner hint when not running as an installed PWA.
 * Does not alter scanner business logic — navigation fallback only.
 */
export function OperatorPwaInstallHint() {
  const pathname = usePathname();
  const onScanRoute = pathname === SCANNER_OPERATOR_SCAN_PATH || pathname.startsWith(`${SCANNER_OPERATOR_SCAN_PATH}/`);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isMobileClient() || isStandaloneDisplay()) return;
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* ignore */
    }
    setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setVisible(false);
  };

  return (
    <div
      className="shrink-0 border-t px-3 py-2 sm:px-4"
      style={{
        borderColor: "var(--scanner-border, #323c48)",
        background: "var(--scanner-header-gradient)",
      }}
      role="region"
      aria-label="Install app hint"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {!onScanRoute ? (
            <Link
              href={SCANNER_OPERATOR_SCAN_PATH}
              className="mb-1 inline-flex items-center gap-1.5 text-[13px] font-bold underline-offset-2 hover:underline"
              style={{ color: "var(--op-accent-gold, #d6b76e)" }}
            >
              <ScanLine className="h-4 w-4 shrink-0" aria-hidden />
              Open Scanner
            </Link>
          ) : null}
          <p className="text-[11px] leading-snug" style={{ color: "var(--op-text-secondary, #b9c2cc)" }}>
            {onScanRoute
              ? "Install: browser menu → Add to Home Screen / Install app."
              : "Install Menorix on your home screen for app-like scanning."}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
          aria-label="Dismiss install hint"
        >
          <X className="h-4 w-4" style={{ color: "var(--scanner-text)" }} aria-hidden />
        </button>
      </div>
    </div>
  );
}
