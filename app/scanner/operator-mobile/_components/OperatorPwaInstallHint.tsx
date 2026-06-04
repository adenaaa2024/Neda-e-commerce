"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Share, X } from "lucide-react";
import { PWA_APP_NAME, PWA_APP_VERSION } from "@/lib/pwa-app-version";
import {
  getDeferredInstallPrompt,
  runDeferredInstallPrompt,
  subscribeInstallPrompt,
} from "@/lib/pwa-install-prompt";
import { isStandaloneDisplay } from "@/lib/pwa-standalone";
import {
  applyWaitingServiceWorkerUpdate,
  subscribeSwUpdate,
} from "@/lib/pwa-sw-update";
import { SCANNER_OPERATOR_SCAN_PATH } from "./ScannerBottomNav";

/** Per-version dismiss key stored in localStorage so the install banner persists across sessions. */
const DISMISS_KEY = `operatorMobile:pwaInstallDismissed:${PWA_APP_VERSION}`;
const PROMPT_WAIT_MS = 2500;

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

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Install / update banner on operator-mobile scan — native prompt when available,
 * iOS share-sheet hint otherwise. Hidden when installed unless a newer version ships.
 */
export function OperatorPwaInstallHint() {
  const pathname = usePathname();
  const onScanRoute =
    pathname === SCANNER_OPERATOR_SCAN_PATH || pathname.startsWith(`${SCANNER_OPERATOR_SCAN_PATH}/`);
  const [installed, setInstalled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [promptPending, setPromptPending] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    setInstalled(isStandaloneDisplay());
  }, []);

  useEffect(() => {
    if (!onScanRoute || !isMobileClient()) {
      setVisible(false);
      return;
    }

    if (installed) {
      return subscribeSwUpdate((available) => {
        setUpdateAvailable(available);
        setVisible(available && !wasDismissed());
      });
    }

    if (wasDismissed()) {
      setVisible(false);
      return;
    }

    setVisible(true);
    setPromptPending(true);
    const timer = window.setTimeout(() => setPromptPending(false), PROMPT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [onScanRoute, installed]);

  useEffect(() => {
    if (!visible || installed) return;
    const sync = () => {
      const ready = Boolean(getDeferredInstallPrompt());
      setCanInstall(ready);
      if (ready) setPromptPending(false);
    };
    sync();
    return subscribeInstallPrompt(sync);
  }, [visible, installed]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
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

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    try {
      await applyWaitingServiceWorkerUpdate();
    } finally {
      setUpdating(false);
    }
  }, []);

  const iosManual = !installed && isIosSafari();
  const androidMenu = !installed && isAndroidChrome() && !canInstall && !iosManual && !promptPending;
  const showUpdate = installed && updateAvailable;

  // BLOCKING overlay: installed PWA with pending update — operator must update before continuing
  if (showUpdate && onScanRoute) {
    return (
      <div
        className="fixed inset-0 z-[300] flex items-center justify-center bg-black/85 p-6"
        role="dialog"
        aria-modal="true"
        aria-label={`Update required — ${PWA_APP_NAME}`}
      >
        <div
          className="w-full max-w-sm rounded-[24px] border p-6 text-center"
          style={{
            borderColor: "var(--op-accent-gold, #d6b76e)",
            background: "var(--scanner-bg, #0a0e14)",
          }}
        >
          <p
            className="text-[18px] font-black leading-snug"
            style={{ color: "var(--op-accent-gold, #d6b76e)" }}
          >
            Update Required
          </p>
          <p className="mt-3 text-[13px] font-semibold leading-relaxed" style={{ color: "var(--op-text-secondary, #b9c2cc)" }}>
            A new version of {PWA_APP_NAME} is available. You must update the app before continuing.
          </p>
          <p className="mt-1 text-[11px] font-medium" style={{ color: "var(--op-text-secondary, #b9c2cc)" }}>
            Version {PWA_APP_VERSION}
          </p>
          <button
            type="button"
            onClick={() => void handleUpdate()}
            disabled={updating}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[14px] font-black transition active:scale-[0.98] disabled:opacity-60"
            style={{
              color: "var(--op-app-bg, #050607)",
              background: "var(--op-accent-gold, #d6b76e)",
            }}
          >
            <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
            {updating ? "Updating…" : "Update & Restart"}
          </button>
        </div>
      </div>
    );
  }

  if (!visible || !onScanRoute) return null;

  return (
    <div
      className="shrink-0 border-t px-3 py-2.5 sm:px-4"
      style={{
        borderColor: "var(--scanner-border, #323c48)",
        background: "var(--scanner-header-gradient)",
      }}
      role="region"
      aria-label={`Install ${PWA_APP_NAME} app`}
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p
            className="text-[12px] font-bold leading-snug"
            style={{ color: "var(--scanner-text, #faf6ed)" }}
          >
            Install {PWA_APP_NAME}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--op-text-secondary, #b9c2cc)" }}>
            {iosManual
              ? "Opens full-screen like an app — tap Share below, then Add to Home Screen."
              : canInstall
                ? "Install as a standalone app — no browser address bar."
                : promptPending
                  ? "Checking install availability…"
                  : androidMenu
                    ? "If the button below does not appear, use Menu ⋮ → Install app (not Shortcut)."
                    : "Install from your browser menu as an app for full-screen mode."}
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
              {installing ? "Installing…" : `Install ${PWA_APP_NAME}`}
            </button>
          ) : iosManual ? (
            <p
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold"
              style={{ color: "var(--op-accent-gold, #d6b76e)" }}
            >
              <Share className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Share → Add to Home Screen
            </p>
          ) : promptPending ? (
            <p
              className="mt-2 text-[11px] font-semibold"
              style={{ color: "var(--op-accent-gold, #d6b76e)" }}
            >
              Preparing install…
            </p>
          ) : null}
        </div>
        {/* Allow dismiss only on non-mobile or after delay — mobile users see banner persistently */}
        {!isMobileClient() ? (
          <button
            type="button"
            onClick={dismiss}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
            aria-label="Dismiss install banner"
          >
            <X className="h-4 w-4" style={{ color: "var(--scanner-text)" }} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
