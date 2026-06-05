"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { PWA_APP_NAME, PWA_APP_VERSION } from "@/lib/pwa-app-version";
import {
  getDeferredInstallPrompt,
  runDeferredInstallPrompt,
  subscribeInstallPrompt,
} from "@/lib/pwa-install-prompt";
import { isMobileBrowser, isStandalonePwa } from "@/lib/pwa-runtime-detection";

const DISMISS_KEY = `operatorMobile:pwaInstallDismissed:${PWA_APP_VERSION}`;
const PROMPT_WAIT_MS = 2500;

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
 * Soft install suggestion for mobile browser — non-blocking unless platform policy hard-requires PWA.
 */
export function OperatorPwaInstallHint() {
  const [visible, setVisible] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [promptPending, setPromptPending] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!isMobileBrowser()) {
      setVisible(false);
      return;
    }

    if (wasDismissed()) {
      setVisible(false);
      return;
    }

    setVisible(true);
    setPromptPending(true);
    const timer = window.setTimeout(() => setPromptPending(false), PROMPT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const sync = () => {
      const ready = Boolean(getDeferredInstallPrompt());
      setCanInstall(ready);
      if (ready) setPromptPending(false);
    };
    sync();
    return subscribeInstallPrompt(sync);
  }, [visible]);

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

  if (isStandalonePwa() || !visible) return null;

  const iosManual = isIosSafari();
  const androidMenu = isAndroidChrome() && !canInstall && !iosManual && !promptPending;

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
            Install {PWA_APP_NAME} for the best scanner experience
          </p>
          <p className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--op-text-secondary, #b9c2cc)" }}>
            {iosManual
              ? "Tap Share below, then Add to Home Screen for full-screen mode."
              : canInstall
                ? "Install as a standalone app — no browser address bar."
                : promptPending
                  ? "Checking install availability…"
                  : androidMenu
                    ? "If the button below does not appear, use Menu ⋮ → Install app."
                    : "Install from your browser menu for full-screen mode."}
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
        <button
          type="button"
          onClick={dismiss}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
          aria-label="Dismiss install suggestion"
        >
          <X className="h-4 w-4" style={{ color: "var(--scanner-text)" }} aria-hidden />
        </button>
      </div>
    </div>
  );
}
