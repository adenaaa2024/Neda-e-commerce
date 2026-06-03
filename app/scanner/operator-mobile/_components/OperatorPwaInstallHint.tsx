"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import {
  getDeferredInstallPrompt,
  runDeferredInstallPrompt,
  subscribeInstallPrompt,
} from "@/lib/pwa-install-prompt";
import { isStandaloneDisplay } from "@/lib/pwa-standalone";
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

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isAndroidChrome(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

/**
 * Install banner on operator-mobile scan — native prompt when available,
 * iOS share-sheet hint otherwise.
 */
export function OperatorPwaInstallHint() {
  const pathname = usePathname();
  const onScanRoute =
    pathname === SCANNER_OPERATOR_SCAN_PATH || pathname.startsWith(`${SCANNER_OPERATOR_SCAN_PATH}/`);
  const [visible, setVisible] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!isMobileClient() || isStandaloneDisplay() || !onScanRoute) return;
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* ignore */
    }
    setVisible(true);
  }, [onScanRoute]);

  useEffect(() => {
    if (!visible || isStandaloneDisplay()) return;
    const sync = () => setCanInstall(Boolean(getDeferredInstallPrompt()));
    sync();
    return subscribeInstallPrompt(sync);
  }, [visible]);

  const dismiss = useCallback(() => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setVisible(false);
  }, []);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      const outcome = await runDeferredInstallPrompt();
      if (outcome === "accepted") dismiss();
    } finally {
      setInstalling(false);
    }
  }, [dismiss]);

  if (!visible || !onScanRoute) return null;

  const iosManual = isIosSafari();
  const androidMenu = isAndroidChrome() && !canInstall && !iosManual;

  return (
    <div
      className="shrink-0 border-t px-3 py-2.5 sm:px-4"
      style={{
        borderColor: "var(--scanner-border, #323c48)",
        background: "var(--scanner-header-gradient)",
      }}
      role="region"
      aria-label="Install Menorix app"
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p
            className="text-[12px] font-bold leading-snug"
            style={{ color: "var(--scanner-text, #faf6ed)" }}
          >
            Install Menorix Scanner
          </p>
          <p className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--op-text-secondary, #b9c2cc)" }}>
            {iosManual
              ? "Opens full-screen like an app — Share → Add to Home Screen (not a browser tab)."
              : canInstall
                ? "Install as a standalone warehouse scanner app — no browser address bar."
                : androidMenu
                  ? "Menu ⋮ → Install app (or Add to Home screen). Avoid “Shortcut” — pick Install for full-screen app."
                  : "Install from your browser menu as an app for full-screen scanner mode."}
          </p>
          {canInstall ? (
            <button
              type="button"
              onClick={() => void handleInstall()}
              disabled={installing}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-bold transition active:scale-[0.98] disabled:opacity-60"
              style={{
                color: "var(--op-app-bg, #050607)",
                background: "var(--op-accent-gold, #d6b76e)",
              }}
            >
              <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {installing ? "Installing…" : "Install app"}
            </button>
          ) : iosManual ? (
            <p
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold"
              style={{ color: "var(--op-accent-gold, #d6b76e)" }}
            >
              <Share className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Share → Add to Home Screen
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
          aria-label="Dismiss install banner"
        >
          <X className="h-4 w-4" style={{ color: "var(--scanner-text)" }} aria-hidden />
        </button>
      </div>
    </div>
  );
}
