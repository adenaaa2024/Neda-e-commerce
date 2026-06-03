"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { isStandaloneDisplay } from "@/lib/pwa-standalone";
import { SCANNER_OPERATOR_SCAN_PATH } from "./ScannerBottomNav";

const DISMISS_KEY = "operatorMobile:pwaHintDismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

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

/**
 * Install banner on operator-mobile scan — native prompt when available,
 * iOS share-sheet hint otherwise.
 */
export function OperatorPwaInstallHint() {
  const pathname = usePathname();
  const onScanRoute =
    pathname === SCANNER_OPERATOR_SCAN_PATH || pathname.startsWith(`${SCANNER_OPERATOR_SCAN_PATH}/`);
  const [visible, setVisible] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
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

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
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
    if (!installPrompt) return;
    setInstalling(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") dismiss();
      setInstallPrompt(null);
    } catch {
      /* ignore */
    } finally {
      setInstalling(false);
    }
  }, [dismiss, installPrompt]);

  if (!visible || !onScanRoute) return null;

  const iosManual = isIosSafari() && !installPrompt;

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
              ? "Tap Share, then “Add to Home Screen” for one-tap warehouse scanning."
              : "Add to your home screen for fast access — opens directly in the mobile scanner."}
          </p>
          {installPrompt ? (
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
